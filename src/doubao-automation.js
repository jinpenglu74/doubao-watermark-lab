'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DOUBAO_CHAT_URL = 'https://www.doubao.com/chat/';
const UPLOAD_MARKER = 'data-watermark-lab-upload';
// 豆包回复结束后，等待图片出现的默认宽限时间（可在界面“无图等待”中调整）
const DEFAULT_NO_IMAGE_GRACE_MS = 30_000;
const VERIFICATION_PATTERN = /请选择所有符合(?:上|下)文描述|拖拽到下方|安全验证|完成验证|人机验证|验证码|滑动验证|请先验证|verify you are human/i;
// 验证通过后的成功文案：出现即视为验证已结束（成功页/成功浮层里常带 verify 类容器，
// 且“已完成验证”本身就含有“完成验证”字样，不做排除会把成功状态误判为仍在验证中，任务永远卡住）
const VERIFICATION_SUCCESS_PATTERN = /验证(?:成功|通过|已完成)|已(?:完成|通过)验证|congratulations|verification (?:successful|succeeded|passed|complete)/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertNotCancelled(isCancelled) {
  if (isCancelled?.()) {
    const error = new Error('批处理已取消');
    error.code = 'CANCELLED';
    throw error;
  }
}

// 同批其他任务完成安全验证后，本任务也可能已被风控波及：抛出专属错误，由调度方整任务重启
function assertNotRestarted(shouldRestart) {
  const restart = shouldRestart?.();
  if (!restart) return;
  const loginRestart = restart === 'login' || restart?.reason === 'login';
  const error = new Error(loginRestart ? '豆包登录会话已恢复，需要重新开始本次任务' : '安全验证已中断本次任务');
  error.code = loginRestart ? 'LOGIN_RECOVERED_RESTART' : 'VERIFICATION_INTERRUPTED';
  throw error;
}

async function waitFor(predicate, {
  timeout = 20_000,
  interval = 500,
  isCancelled,
  message = '等待页面元素超时'
} = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    assertNotCancelled(isCancelled);
    const value = await predicate();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(message);
}

async function runInPage(webContents, fn, ...args) {
  const source = `(${fn.toString()})(...${JSON.stringify(args)})`;
  let timer = null;
  try {
    return await Promise.race([
      webContents.executeJavaScript(source, true),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('豆包页面响应超时，请刷新页面后重试')), 30_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// 会话页就绪探针：输入框或上传控件出现即视为可以继续，用于替代导航后的固定 sleep
function pageChatInputReady() {
  const composer = document.querySelector('textarea, [contenteditable="true"]');
  if (composer) {
    const rect = composer.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }
  return Boolean(document.querySelector('input[type="file"]'));
}

// 新对话就绪探针：点击"新对话"后旧会话视图还会短暂残留（旧输入框/上传控件仍在），
// 必须等 URL 中的会话 ID 消失（视图已切换）且输入控件就绪，否则可能把图片传进旧会话
function pageNewConversationReady() {
  if (/\/chat\/[0-9a-zA-Z]{8,}(?:[/?#]|$)/.test(location.href)) return false;
  const composer = document.querySelector('textarea, [contenteditable="true"]');
  if (composer) {
    const rect = composer.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }
  return Boolean(document.querySelector('input[type="file"]'));
}

// ---------- 无水印原图直取（集成自 doubao-no-watermark 项目） ----------
// 原理：豆包 chat/completion 接口的 SSE 流里直接返回 image_ori_raw.url（无水印原图地址），
// 页面展示的是带水印缩略图（image_thumb）。递归深搜比硬编码字段路径更抗接口结构变化。
function harvestImageRawUrls(node, found, depth = 0) {
  if (!node || depth > 12) return;
  if (Array.isArray(node)) {
    for (const item of node) harvestImageRawUrls(item, found, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const raw = node.image_ori_raw;
  if (raw && typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url)) {
    const key = (String(raw.url).match(/rc_gen_image\/([^?~]+)/) || [])[1] || raw.url;
    if (!found.has(key)) {
      found.set(key, {
        url: raw.url,
        watermarkUrl: typeof node.image_thumb?.url === 'string' ? node.image_thumb.url : null,
        width: Number(raw.width) || 0,
        height: Number(raw.height) || 0,
        source: 'api-raw',
        likelyOriginal: true,
        seenAt: Date.now()
      });
    }
  }
  for (const value of Object.values(node)) harvestImageRawUrls(value, found, depth + 1);
}

// 解析 SSE 文本：按事件块切分，取 data: 行的 JSON 递归提取
function harvestSseText(text, found) {
  for (const chunk of String(text || '').split('\n\n')) {
    const match = chunk.match(/^data: (.+)$/m);
    if (!match) continue;
    try {
      harvestImageRawUrls(JSON.parse(match[1]), found);
    } catch { /* 心跳或非 JSON 事件，忽略 */ }
  }
}

function clamp01(value) {
  let number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number > 1 && number <= 100) number /= 100;
  return Math.min(1, Math.max(0, number));
}

function normalizeAuditRegion(region, fallbackConfidence = 0) {
  if (!region || typeof region !== 'object') return null;
  let x = clamp01(region.x ?? region.left ?? region.x1);
  let y = clamp01(region.y ?? region.top ?? region.y1);
  let w = clamp01(region.w ?? region.width);
  let h = clamp01(region.h ?? region.height);
  const right = clamp01(region.right ?? region.x2);
  const bottom = clamp01(region.bottom ?? region.y2);
  if (w === null && x !== null && right !== null) w = Math.max(0, right - x);
  if (h === null && y !== null && bottom !== null) h = Math.max(0, bottom - y);
  if ([x, y, w, h].some((value) => value === null)) return null;
  if (x + w > 1) w = Math.max(0, 1 - x);
  if (y + h > 1) h = Math.max(0, 1 - y);
  if (w <= 0.001 || h <= 0.001) return null;
  const confidence = clamp01(region.confidence ?? region.score);
  return {
    x,
    y,
    w,
    h,
    confidence: confidence === null ? fallbackConfidence : confidence,
    kind: typeof region.kind === 'string' ? region.kind.slice(0, 40) : ''
  };
}

function parseWatermarkAudit(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const unfenced = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let payload;
  try {
    payload = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const confidence = clamp01(payload.confidence ?? payload.score);
  const rawRegions = Array.isArray(payload.regions)
    ? payload.regions
    : Array.isArray(payload.boxes)
      ? payload.boxes
      : [];
  const explicit = payload.hasResidual ?? payload.has_residual ?? payload.residual;
  const provisionalHasResidual = typeof explicit === 'boolean' ? explicit : rawRegions.length > 0;
  const safeConfidence = confidence === null ? (provisionalHasResidual ? 0.75 : 0) : confidence;
  const regions = rawRegions
    .slice(0, 48)
    .map((region) => normalizeAuditRegion(region, safeConfidence))
    .filter(Boolean);
  const hasResidual = typeof explicit === 'boolean' ? explicit : regions.length > 0;
  return {
    hasResidual,
    confidence: safeConfidence,
    regions: hasResidual ? regions : []
  };
}

function pageLoginStatus() {
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const controls = [...document.querySelectorAll('button, a, [role="button"]')]
    .filter(visible)
    .map((element) => `${element.innerText || ''} ${element.getAttribute('aria-label') || ''} ${element.title || ''}`.trim());
  const hasLogin = controls.some((text) => /^(登录|注册|登录豆包|立即登录)(?:\s|$)/.test(text));
  const hasAccount = Boolean(document.querySelector('img[src*="user-avatar" i], button[aria-haspopup="menu"] img[src*="avatar" i], [data-testid*="user-avatar" i], img[alt*="头像"]'));
  const hasComposer = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
    .some((element) => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true');
  // 文件 input 通常是隐藏的，存在即可视为聊天能力信号，不要求 visible。
  const hasUpload = Boolean(document.querySelector('input[type="file"]'));
  const url = location.href;
  const isChatUrl = /\/chat(?:\/|[?#]|$)/i.test(location.pathname + location.search + location.hash);
  const isLoginPage = /\/(?:login|passport|auth)(?:\/|[?#]|$)/i.test(location.pathname)
    || /passport|login/i.test(location.hostname) && !/doubao\.com$/i.test(location.hostname);
  return {
    hasLogin,
    hasAccount,
    hasComposer,
    hasUpload,
    isChatUrl,
    isLoginPage,
    url
  };
}

function classifyLoginState(pageStatus = {}, cookieHint = false) {
  const hasLogin = pageStatus?.hasLogin === true;
  const hasAccount = pageStatus?.hasAccount === true;
  const hasComposer = pageStatus?.hasComposer === true;
  const hasUpload = pageStatus?.hasUpload === true;
  const isChatUrl = pageStatus?.isChatUrl === true || /\/chat(?:\/|[?#]|$)/i.test(String(pageStatus?.url || ''));
  const isLoginPage = pageStatus?.isLoginPage === true;

  let score = 0;
  if (hasComposer) score += 4;
  if (hasUpload) score += 3;
  if (hasAccount) score += 3;
  if (cookieHint) score += 2;
  if (isChatUrl) score += 1;
  if (hasLogin) score -= 5;
  if (isLoginPage) score -= 5;

  let state = 'uncertain';
  // 可实际发送消息/上传文件比头像是否渲染更可靠，避免侧栏折叠或 DOM 重绘造成假退出。
  if (!hasLogin && !isLoginPage && (hasComposer || hasUpload || hasAccount) && score >= 4) {
    state = 'authenticated';
  } else if ((hasLogin || isLoginPage) && !hasComposer && !hasUpload && !hasAccount) {
    state = 'logged-out';
  }

  return {
    ...pageStatus,
    cookieHint: Boolean(cookieHint),
    state,
    score,
    loggedIn: state === 'authenticated'
  };
}

function pageVerificationState(patternSource) {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 30 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const successPattern = /验证(?:成功|通过|已完成)|已(?:完成|通过)验证|congratulations|verification (?:successful|succeeded|passed|complete)/i;
  const pattern = new RegExp(patternSource, 'i');
  const candidates = [...document.querySelectorAll(
    '[role="dialog"], [aria-modal="true"], iframe, [class*="captcha" i], [class*="verify" i], [id*="captcha" i], [id*="verify" i]'
  )].filter(visible);
  const text = candidates
    .filter((element) => element.tagName !== 'IFRAME')
    .map((element) => element.innerText || element.textContent || '')
    .join('\n')
    .trim();
  const bodyText = document.body?.innerText || '';
  // 图形验证通过后豆包可能追加手机号/短信验证：这一步常与「验证成功」文案相继或同屏出现，
  // 不能让成功文案否决它，否则会在用户输手机号时误判完成、把窗口收起来
  const phoneVerifyPattern = /手机号(?:验证|校验)|验证手机号|绑定手机|短信验证码|获取(?:短信)?验证码|输入(?:短信)?验证码/i;
  if (phoneVerifyPattern.test(`${text}\n${bodyText.slice(0, 1500)}`)) {
    return { detected: true, summary: text.replace(/\s+/g, ' ').slice(0, 160) };
  }
  const hasSpecificChallengeCopy = /请选择所有符合(?:上|下)文描述的图片|拖拽到下方|verify you are human/i.test(bodyText);
  const hasChallengeFrame = candidates.some((element) => element.tagName === 'IFRAME'
    && /captcha|verify|challenge|secsdk|geetest/i.test(`${element.src || ''} ${element.name || ''} ${element.title || ''}`));
  const hasChallengeContainer = candidates.some((element) => element.tagName !== 'IFRAME'
    && /captcha|verify|challenge|secsdk|geetest/i.test(`${element.id || ''} ${element.className || ''}`));
  // 成功文案具有否决权：验证成功页/成功浮层里仍会残留 verify 类容器和“完成验证”字样
  const successZones = `${document.title || ''}\n${text}\n${bodyText.slice(0, 1500)}`;
  if (successPattern.test(successZones)) {
    return { detected: false, summary: text.replace(/\s+/g, ' ').slice(0, 160) };
  }
  // 匹配指令文案前先剔除成功字样，避免“已完成验证”误中“完成验证”
  const instructionText = text.replace(successPattern, '');
  const patternHit = pattern.test(instructionText);
  // 没有挑战 iframe、没有任何指令文案，且聊天输入框已可用：
  // 说明挑战浮层已消失，残留的 verify 类空容器不算仍在验证
  if (!hasChallengeFrame && !hasSpecificChallengeCopy && !patternHit) {
    const hasComposer = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
      .some((element) => visible(element) && !element.disabled);
    if (hasComposer) {
      return { detected: false, summary: text.replace(/\s+/g, ' ').slice(0, 160) };
    }
  }
  return {
    detected: hasChallengeFrame || hasChallengeContainer || hasSpecificChallengeCopy || patternHit,
    summary: text.replace(/\s+/g, ' ').slice(0, 160)
  };
}

function clickAttachmentControl() {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const controls = [...document.querySelectorAll('button, [role="button"], [aria-label], [title]')]
    .filter(visible)
    .map((element) => {
      const label = `${element.innerText || ''} ${element.getAttribute('aria-label') || ''} ${element.title || ''}`;
      const rect = element.getBoundingClientRect();
      let score = rect.top / Math.max(innerHeight, 1);
      if (/上传|图片|照片|文件|附件|upload|image|photo/i.test(label)) score += 10;
      if (rect.top > innerHeight * 0.45) score += 3;
      return { element, score };
    })
    .filter((item) => item.score >= 10)
    .sort((a, b) => b.score - a.score);

  if (controls[0]) {
    controls[0].element.click();
    return true;
  }
  return false;
}

function clickLoginButton() {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const candidates = [...document.querySelectorAll('button, a, [role="button"]')]
    .filter(visible)
    .map((element) => {
      const text = `${element.innerText || ''} ${element.getAttribute('aria-label') || ''} ${element.title || ''}`.trim();
      let score = 0;
      if (/^(登录|登录豆包|立即登录)$/.test(text)) score += 20;
      else if (/登录/.test(text)) score += 8;
      return { element, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!candidates[0]) return false;
  candidates[0].element.click();
  return true;
}

function pageImageSnapshot() {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const images = [...document.images]
    .filter(visible)
    .map((image) => {
      let userMessage = false;
      let generatedContainer = false;
      let ancestor = image;
      for (let depth = 0; ancestor && depth < 12; depth += 1, ancestor = ancestor.parentElement) {
        const className = String(ancestor.className || '');
        const messageRole = `${ancestor.getAttribute?.('data-message-role') || ''} ${ancestor.getAttribute?.('data-role') || ''} ${ancestor.getAttribute?.('data-author') || ''}`;
        if (/(?:^|\s)(?:justify-end|items-end)(?:\s|$)/.test(className) || /(?:^|\s)user(?:\s|$)/i.test(messageRole)) {
          userMessage = true;
        }
        if (/image-wrapper-|image-box-grid-|(?:^|\s)assistant(?:\s|$)/i.test(`${className} ${messageRole}`)) {
          generatedContainer = true;
        }
      }
      const picture = image.closest('picture');
      const values = [image.currentSrc, image.src, image.getAttribute('src'), image.srcset];
      if (picture) {
        picture.querySelectorAll('source').forEach((source) => {
          values.push(source.src, source.srcset);
        });
      }
      const httpUrl = values
        .filter(Boolean)
        .flatMap((value) => String(value).split(','))
        .map((value) => value.trim().split(/\s+/)[0])
        .find((value) => /^https?:\/\//i.test(value));
      const rect = image.getBoundingClientRect();
      return {
        url: httpUrl || '',
        width: Math.max(image.naturalWidth || 0, Number(image.getAttribute('width')) || 0),
        height: Math.max(image.naturalHeight || 0, Number(image.getAttribute('height')) || 0),
        displayWidth: Math.round(rect.width),
        displayHeight: Math.round(rect.height),
        pending: !image.complete,
        alt: image.alt || '',
        baseline: image.hasAttribute('data-watermark-lab-baseline'),
        userMessage,
        generatedContainer
      };
    })
    .filter((image) => /^https?:\/\//i.test(image.url));

  const controls = [...document.querySelectorAll('button, [role="button"]')]
    .filter(visible)
    .map((element) => `${element.innerText || ''} ${element.getAttribute('aria-label') || ''} ${element.title || ''}`);
  const generating = controls.some((text) => /停止生成|停止回答|停止创作|正在生成|生成中/i.test(text));
  const finishedReplies = controls.filter((text) => /重新生成|重新回答|换一换/.test(text)).length;
  const followUps = [...document.querySelectorAll('button, [role="button"], a, li, [class*="suggest" i], [class*="question" i], [class*="follow-up" i], [class*="recommend" i]')]
    .filter(visible)
    .map((element) => (element.innerText || element.textContent || '').trim())
    .filter((text) => /^[^\n]{6,80}[？?]$/.test(text)).length;
  const bodyText = document.body?.innerText || '';
  // 提取最后一条豆包回复的纯文本：按消息行筛选，剔除用户气泡、联想问题、操作按钮等杂质
  // （消息行嵌套在 message-list 的虚拟列表里，行容器的特征是 max-w-(--content-max-width) 类）
  const messageRows = [...document.querySelectorAll('[class*="message-list-"]:not([class*="suggest"]) [class*="max-w-(--content-max-width)"]')];
  const lastAssistantRow = messageRows
    .filter((row) => !row.querySelector('[class*="send-msg-bubble-bg"]'))
    .filter((row) => String(row.innerText || '').trim())
    .at(-1);
  let assistantTailText = '';
  if (lastAssistantRow) {
    const clone = lastAssistantRow.cloneNode(true);
    clone.querySelectorAll('[class*="suggest"], [class*="message-action-bar"], [class*="send-msg-bubble-bg"], button, [role="button"], nav')
      .forEach((element) => element.remove());
    assistantTailText = String(clone.innerText || '').trim();
  }
  return {
    images,
    generating,
    finishedReplies,
    followUps,
    tailText: bodyText.slice(-1200),
    assistantTailText
  };
}

function markExistingImages() {
  document.querySelectorAll('main img').forEach((image) => {
    image.setAttribute('data-watermark-lab-baseline', '1');
  });
  return true;
}

function openLatestGeneratedPreview(candidateUrls = []) {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 80 && rect.height > 60 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const candidateKeys = candidateUrls.map((value) => {
    try {
      return new URL(value).pathname.split('/').pop().split('~')[0];
    } catch {
      return '';
    }
  }).filter((value) => value.length >= 8);

  const images = [...document.querySelectorAll('main img')]
    .filter(visible)
    .map((image, index) => {
      let userMessage = false;
      let generatedContainer = false;
      let ancestorForRole = image;
      for (let depth = 0; ancestorForRole && depth < 12; depth += 1, ancestorForRole = ancestorForRole.parentElement) {
        const className = String(ancestorForRole.className || '');
        const messageRole = `${ancestorForRole.getAttribute?.('data-message-role') || ''} ${ancestorForRole.getAttribute?.('data-role') || ''} ${ancestorForRole.getAttribute?.('data-author') || ''}`;
        if (/(?:^|\s)(?:justify-end|items-end)(?:\s|$)/.test(className) || /(?:^|\s)user(?:\s|$)/i.test(messageRole)) {
          userMessage = true;
        }
        if (/image-wrapper-|image-box-grid-|(?:^|\s)assistant(?:\s|$)/i.test(`${className} ${messageRole}`)) {
          generatedContainer = true;
        }
      }
      const picture = image.closest('picture');
      const sourceValues = picture
        ? [...picture.querySelectorAll('source')].map((source) => `${source.src || ''} ${source.srcset || ''}`).join(' ')
        : '';
      const urls = `${image.currentSrc || ''} ${image.src || ''} ${image.getAttribute('src') || ''} ${image.srcset || ''} ${sourceValues}`;
      const rect = image.getBoundingClientRect();
      const declaredWidth = Math.max(image.naturalWidth || 0, Number(image.getAttribute('width')) || 0, rect.width || 0);
      const declaredHeight = Math.max(image.naturalHeight || 0, Number(image.getAttribute('height')) || 0, rect.height || 0);
      const matchedNetworkCandidate = candidateKeys.some((key) => urls.includes(key));
      const generatedUrl = /\/rc_gen_image\/|downsize_watermark|(?:^|[/_-])(?:generated|aigc|generate)(?:[/_.-]|$)/i.test(urls);
      let score = index / 1000;
      if (!image.hasAttribute('data-watermark-lab-baseline')) score += 100;
      else score -= 240;
      if (matchedNetworkCandidate) score += 220;
      if (generatedUrl) score += 100;
      if (generatedContainer) score += 80;
      if (userMessage) score -= 10_000;
      if ((image.alt || '').toLowerCase() === 'image') score += 30;
      if (declaredWidth * declaredHeight >= 200_000) score += 30;
      return { image, score, urls, userMessage, generatedContainer, generatedUrl, matchedNetworkCandidate };
    })
    .filter((item) => !item.userMessage)
    .filter((item) => item.matchedNetworkCandidate || item.generatedUrl || item.generatedContainer)
    .sort((a, b) => b.score - a.score);
  const selected = images[0];
  if (!selected) {
    return {
      opened: false,
      reason: 'no-generated-reply-image',
      candidateCount: candidateKeys.length
    };
  }
  const image = selected.image;

  let clickTarget = image;
  let ancestor = image.parentElement;
  for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
    const className = String(ancestor.className || '');
    const cursor = getComputedStyle(ancestor).cursor;
    if (/clickable|image-wrapper/i.test(className) || ancestor.getAttribute('role') === 'button' || cursor === 'pointer') {
      clickTarget = ancestor;
      break;
    }
  }
  clickTarget.scrollIntoView({ block: 'center', inline: 'nearest' });
  clickTarget.click();
  return {
    opened: true,
    score: Math.round(selected.score),
    matchedNetworkCandidate: selected.matchedNetworkCandidate,
    generatedUrl: selected.generatedUrl,
    generatedContainer: selected.generatedContainer,
    userMessage: selected.userMessage
  };
}

function editorCanvasState(includeData = false) {
  const canvases = [...document.querySelectorAll('aside canvas, [role="complementary"] canvas, canvas')]
    .filter((canvas) => {
      const rect = canvas.getBoundingClientRect();
      const style = getComputedStyle(canvas);
      return canvas.width >= 480 && canvas.height >= 320 && rect.width >= 240 && rect.height >= 160
        && style.visibility !== 'hidden' && style.display !== 'none';
    })
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const canvas = canvases[0];
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const result = {
    width: canvas.width,
    height: canvas.height,
    rect: {
      x: Math.max(0, Math.floor(rect.x)),
      y: Math.max(0, Math.floor(rect.y)),
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height))
    }
  };
  if (!includeData) return result;
  try {
    result.dataUrl = HTMLCanvasElement.prototype.toDataURL.call(canvas, 'image/png');
  } catch (error) {
    result.error = String(error?.message || error);
  }
  return result;
}

function clickEditorDownload() {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const buttons = [...document.querySelectorAll('button, [role="button"]')]
    .filter(visible)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const label = `${element.innerText || ''} ${element.getAttribute('aria-label') || ''} ${element.title || ''}`.trim();
      let score = 0;
      if (/^(?:保存|下载|保存图片|下载图片)$/.test(label)) score += 100;
      else if (/保存|下载/.test(label)) score += 40;
      if (rect.top < innerHeight * 0.25 && rect.left > innerWidth * 0.45) score += 15;
      return { element, label, score };
    })
    .filter((item) => item.score >= 40)
    .sort((a, b) => b.score - a.score);
  if (!buttons[0]) return { clicked: false };
  buttons[0].element.click();
  return { clicked: true, label: buttons[0].label };
}

function setComposerText(text) {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 80 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const elements = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
    .filter(visible)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const hint = `${element.getAttribute('placeholder') || ''} ${element.getAttribute('aria-label') || ''}`;
      let score = rect.top / Math.max(innerHeight, 1);
      if (/发送|消息|输入|问问|描述|prompt|message/i.test(hint)) score += 10;
      if (rect.top > innerHeight * 0.45) score += 4;
      return { element, score };
    })
    .sort((a, b) => b.score - a.score);

  const target = elements[0]?.element;
  if (!target) return { ok: false };
  target.focus();

  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(target, text);
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    target.innerHTML = '';
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  return {
    ok: true,
    value: (target.value || target.innerText || target.textContent || '').trim().slice(0, 120),
    tag: target.tagName
  };
}

function clickSendButton() {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 4 && rect.height > 4 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const controls = [...document.querySelectorAll('button, [role="button"]')]
    .filter((element) => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true')
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const label = `${element.innerText || ''} ${element.getAttribute('aria-label') || ''} ${element.title || ''} ${element.getAttribute('data-testid') || ''}`;
      let score = 0;
      if (/发送|send/i.test(label)) score += 12;
      if (rect.top > innerHeight * 0.55) score += 3;
      if (rect.left > innerWidth * 0.45) score += 2;
      return { element, score, label };
    })
    .filter((item) => item.score >= 12)
    .sort((a, b) => b.score - a.score);
  if (!controls[0]) return { clicked: false };
  controls[0].element.click();
  return { clicked: true, label: controls[0].label };
}

function clickNewConversation() {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 4 && rect.height > 4 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const target = [...document.querySelectorAll('button, a, [role="button"]')]
    .filter(visible)
    .find((element) => /新对话|新聊天|开启新对话|发起对话/.test(`${element.innerText || ''} ${element.getAttribute('aria-label') || ''} ${element.title || ''}`));
  if (!target) return false;
  target.click();
  return true;
}

function responseHeader(headers, name) {
  if (!headers) return '';
  const targetName = String(name).toLowerCase();
  const normalize = (value) => {
    if (Array.isArray(value)) return value[0] || '';
    if (value && typeof value === 'object' && 'value' in value) return normalize(value.value);
    return value == null ? '' : String(value);
  };

  if (typeof headers.get === 'function') return normalize(headers.get(name));
  if (Array.isArray(headers)) {
    const item = headers.find((header) => {
      if (Array.isArray(header)) return String(header[0]).toLowerCase() === targetName;
      return String(header?.name || '').toLowerCase() === targetName;
    });
    return Array.isArray(item) ? normalize(item[1]) : normalize(item?.value);
  }
  if (typeof headers === 'object') {
    const key = Object.keys(headers).find((headerName) => headerName.toLowerCase() === targetName);
    return key ? normalize(headers[key]) : '';
  }
  return '';
}

function imageAssetKey(value) {
  try {
    const url = new URL(value);
    return decodeURIComponent(url.pathname.replace(/~tplv-[^/]+$/i, '')).toLowerCase();
  } catch {
    return '';
  }
}

function conversationIdFromUrl(value) {
  const match = String(value || '').match(/\/chat\/([0-9a-zA-Z]{8,})(?:[/?#]|$)/);
  return match ? match[1] : '';
}

function noImageGeneratedError(tailText, promptText = '') {
  let excerpt = String(tailText || '').replace(/\s+/g, ' ').trim();
  // 兜底剔除用户自己发送的内容，报错里只保留豆包的输出；
  // 只剔除独立出现的发送内容（两侧不是汉字），避免误伤“你好呀”这类包含关系
  const sent = String(promptText || '').replace(/\s+/g, ' ').trim();
  if (sent) {
    const escaped = sent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    excerpt = excerpt
      .replace(new RegExp(`(?<![\\u4e00-\\u9fa5])${escaped}(?![\\u4e00-\\u9fa5])`, 'g'), ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  excerpt = excerpt.slice(0, 160);
  const suffix = excerpt ? `；豆包回复：“${excerpt}”` : '';
  const error = new Error(`豆包回复已结束，但没有生成图片，提示词可能不合适，请调整后重试${suffix}`);
  error.code = 'NO_IMAGE_GENERATED';
  return error;
}

// 多线程并行时多个工作窗口共享同一个 session，webRequest 每个事件只能注册一个监听器，
// 因此用按 session 复用的转发中心，把网络候选按 webContentsId 路由给对应的工作线程
const sessionCaptureHubs = new WeakMap();

function sessionCaptureHub(session) {
  let hub = sessionCaptureHubs.get(session);
  if (hub) return hub;
  const handlers = new Set();
  const filter = { urls: ['http://*/*', 'https://*/*'] };
  session.webRequest.onCompleted(filter, (details) => {
    for (const handler of [...handlers]) {
      try {
        handler(details);
      } catch {
        // A malformed response must never crash Electron's main process.
      }
    }
  });
  hub = { handlers };
  sessionCaptureHubs.set(session, hub);
  return hub;
}

class DoubaoAutomation {
  constructor(browserWindow, options = {}) {
    this.window = browserWindow;
    this.webContents = browserWindow.webContents;
    this.session = this.webContents.session;
    this.isCancelled = options.isCancelled || (() => false);
    // 任一任务完成安全验证后，同批其他任务也会被风控波及：由调度方通过该回调通知整任务重启
    this.shouldRestart = options.shouldRestart || (() => false);
    this.onProgress = options.onProgress || (() => {});
    this.onVerificationRequired = options.onVerificationRequired || null;
    this.onVerificationCleared = options.onVerificationCleared || null;
  }

  async cookieLoginHint() {
    try {
      const cookies = await this.session.cookies.get({ url: 'https://www.doubao.com/' });
      return cookies.some((cookie) => !/csrf/i.test(cookie.name)
        && /^(?:sessionid(?:_ss)?|sid_(?:guard|tt)|uid_tt(?:_ss)?|passport_auth_status|sso_auth_status)$/i.test(cookie.name));
    } catch {
      return false;
    }
  }

  async getLoginStatus() {
    if (this.webContents.isLoading()) {
      await waitFor(() => !this.webContents.isLoading(), {
        timeout: 25_000,
        isCancelled: this.isCancelled,
        message: '豆包页面加载超时'
      }).catch((error) => {
        if (error?.code === 'CANCELLED') throw error;
      });
    }
    const [pageStatus, cookieHint] = await Promise.all([
      runInPage(this.webContents, pageLoginStatus).catch(() => null),
      this.cookieLoginHint()
    ]);
    return classifyLoginState(pageStatus || {}, cookieHint);
  }

  async confirmLoginStatus({ attempts = 3 } = {}) {
    const total = Math.min(5, Math.max(2, Math.round(Number(attempts) || 3)));
    let last = null;
    let consecutiveLoggedOut = 0;
    for (let attempt = 0; attempt < total; attempt += 1) {
      assertNotCancelled(this.isCancelled);
      last = await this.getLoginStatus().catch((error) => {
        if (error?.code === 'CANCELLED') throw error;
        return classifyLoginState({}, false);
      });
      if (last.state === 'authenticated') return { ...last, confirmed: true, checks: attempt + 1 };
      consecutiveLoggedOut = last.state === 'logged-out' ? consecutiveLoggedOut + 1 : 0;
      // 明确退出也必须连续出现两次，避免页面切换/重绘瞬间把登录按钮误当成真实退出。
      if (consecutiveLoggedOut >= 2) return { ...last, confirmed: true, checks: attempt + 1 };
      if (attempt < total - 1) {
        this.onProgress(`登录状态异常，正在自动复查（${attempt + 1}/${total}）`);
        await sleep(attempt === 0 ? 800 : 1400);
      }
    }
    return { ...(last || classifyLoginState({}, false)), confirmed: false, checks: total };
  }

  async requireAuthenticated() {
    const status = await this.confirmLoginStatus({ attempts: 3 });
    if (status.state === 'authenticated') return status;
    const error = new Error('豆包登录状态需要恢复');
    error.code = 'LOGIN_RECOVERY_REQUIRED';
    error.authStatus = status;
    throw error;
  }

  async waitForVerificationIfNeeded(maxWaitMs = 10 * 60_000) {
    assertNotRestarted(this.shouldRestart);
    const first = await runInPage(this.webContents, pageVerificationState, VERIFICATION_PATTERN.source)
      .catch(() => ({ detected: false }));
    if (!first?.detected) return { waitedMs: 0, detected: false };

    const wasVisible = this.window.isVisible();
    // 弹窗决策交给调度方：回调返回 false 表示已有其他窗口在验证中（本任务是跟随者），
    // 不弹出本窗口，静默等待领头任务完成验证后随重启信号一起重跑。
    // 没有回调时（直接使用自动化层）退回旧行为：自己弹出窗口
    let isLeader = true;
    if (this.onVerificationRequired) {
      const decision = await Promise.resolve(this.onVerificationRequired({ wasVisible })).catch(() => true);
      isLeader = decision !== false;
    } else {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.moveTop();
      this.window.focus();
    }
    this.onProgress(isLeader
      ? '检测到豆包安全验证：任务已暂停，请在豆包窗口手动完成'
      : '检测到安全验证：另一个窗口正在验证，完成一次即可，本任务已暂停等待自动重跑');
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      assertNotCancelled(this.isCancelled);
      // 领头任务完成验证后会广播重启信号：跟随者立即中断等待，整任务重跑
      assertNotRestarted(this.shouldRestart);
      await sleep(1200);
      const current = await runInPage(this.webContents, pageVerificationState, VERIFICATION_PATTERN.source)
        .catch(() => ({ detected: true }));
      if (!current?.detected) {
        // 图形验证通过后豆包可能紧接着弹手机号验证，中间隔着成功动画/过渡页：
        // 连续多轮确认页面确实干净才算真正完成，避免在过渡瞬间收起窗口、
        // 让用户看不到手机号验证界面
        let confirmed = true;
        for (let round = 0; round < 3; round += 1) {
          await sleep(1500);
          assertNotCancelled(this.isCancelled);
          assertNotRestarted(this.shouldRestart);
          const again = await runInPage(this.webContents, pageVerificationState, VERIFICATION_PATTERN.source)
            .catch(() => ({ detected: true }));
          if (again?.detected) {
            confirmed = false;
            break;
          }
        }
        if (!confirmed) continue;
        if (this.onVerificationCleared) {
          await Promise.resolve(this.onVerificationCleared({ wasVisible })).catch(() => {});
        } else if (!wasVisible && !this.window.isDestroyed()) {
          this.window.hide();
        }
        this.onProgress('安全验证已完成，正在重新开始任务');
        // 验证中断后豆包可能假死（一直“生成中”）或静默放弃本次生成，
        // 继续等待不可靠：抛出专属错误，由调度方整任务重新开始
        const error = new Error('安全验证已中断本次任务');
        error.code = 'VERIFICATION_INTERRUPTED';
        throw error;
      }
    }
    throw new Error('等待手动完成豆包安全验证超时；请完成验证后重新开始任务');
  }

  async openLoginDialog() {
    if (this.webContents.isLoading()) {
      await waitFor(() => !this.webContents.isLoading(), {
        timeout: 30_000,
        isCancelled: this.isCancelled,
        message: '豆包登录页面加载超时'
      });
    }
    const status = await this.getLoginStatus();
    if (status.loggedIn) return { alreadyLoggedIn: true, opened: false };
    const opened = await waitFor(
      () => runInPage(this.webContents, clickLoginButton),
      {
        timeout: 15_000,
        interval: 700,
        isCancelled: this.isCancelled,
        message: '没有找到豆包登录按钮，请稍后重试'
      }
    );
    await sleep(500);
    return { alreadyLoggedIn: false, opened: Boolean(opened) };
  }

  // 会话页就绪等待：导航后不再死板 sleep，输入框或上传控件一出现就继续（超时兜底静默放行，
  // 后续 attachFile/enterPrompt 各自的等待会兜住真正没就绪的情况）
  async waitForChatReady(maxWaitMs = 5000, probe = pageChatInputReady) {
    await waitFor(() => runInPage(this.webContents, probe).catch(() => false), {
      timeout: maxWaitMs,
      interval: 250,
      isCancelled: this.isCancelled
    }).catch((error) => {
      if (error?.code === 'CANCELLED') throw error;
    });
  }

  async freshConversation() {
    this.onProgress('正在创建新对话');
    const clicked = await runInPage(this.webContents, clickNewConversation).catch(() => false);
    if (clicked) {
      await this.waitForChatReady(5000, pageNewConversationReady);
      // 视图切换后留一小段稳定时间，避免附件落到即将被替换的旧 DOM 上（原来固定等 1400ms）
      await sleep(800);
      return;
    }
    await this.window.loadURL(DOUBAO_CHAT_URL);
    await waitFor(() => !this.webContents.isLoading(), {
      timeout: 30_000,
      isCancelled: this.isCancelled,
      message: '豆包页面加载超时'
    });
    await this.waitForChatReady();
  }

  async openConversation(conversationId) {
    this.onProgress('正在打开该任务的历史对话');
    const currentUrl = await runInPage(this.webContents, () => location.href).catch(() => '');
    if (conversationIdFromUrl(currentUrl) === conversationId) return true;
    await this.window.loadURL(`${DOUBAO_CHAT_URL}${conversationId}`);
    await waitFor(() => !this.webContents.isLoading(), {
      timeout: 30_000,
      isCancelled: this.isCancelled,
      message: '豆包页面加载超时'
    });
    await this.waitForChatReady();
    const landedUrl = await runInPage(this.webContents, () => location.href).catch(() => '');
    return conversationIdFromUrl(landedUrl) === conversationId;
  }

  async attachFile(filePath) {
    this.onProgress('正在上传原图');
    const debuggerApi = this.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');

    let attachmentClickAttempted = false;
    const nodeId = await waitFor(async () => {
      const documentNode = await debuggerApi.sendCommand('DOM.getDocument', { depth: 2, pierce: true });
      const query = await debuggerApi.sendCommand('DOM.querySelectorAll', {
        nodeId: documentNode.root.nodeId,
        selector: 'input[type="file"]'
      });
      const scored = [];
      for (const candidateNodeId of query.nodeIds || []) {
        const result = await debuggerApi.sendCommand('DOM.getAttributes', { nodeId: candidateNodeId });
        const attributes = {};
        for (let index = 0; index < result.attributes.length; index += 2) {
          attributes[result.attributes[index]] = result.attributes[index + 1];
        }
        if ('disabled' in attributes) continue;
        const accept = attributes.accept || '';
        let score = /image|\.png|\.jpe?g|\.webp|\.bmp/i.test(accept) ? 20 : 0;
        if ('multiple' in attributes) score += 3;
        scored.push({ nodeId: candidateNodeId, score });
      }
      scored.sort((a, b) => b.score - a.score);
      if (scored[0]?.score > 0) return scored[0].nodeId;

      if (!attachmentClickAttempted) {
        attachmentClickAttempted = true;
        await runInPage(this.webContents, clickAttachmentControl).catch(() => false);
      }
      return false;
    }, {
      timeout: 20_000,
      interval: 400,
      isCancelled: this.isCancelled,
      message: '没有找到豆包的图片上传控件；请确认当前是普通对话页面并刷新重试'
    });

    await debuggerApi.sendCommand('DOM.setAttributeValue', {
      nodeId,
      name: UPLOAD_MARKER,
      value: '1'
    });
    await debuggerApi.sendCommand('DOM.setFileInputFiles', {
      files: [filePath],
      nodeId
    });
  }

  // 上传预览等待独立出来：设置文件后 attachFile 立即返回，调用方可以先填提示词再等上传完成
  async waitForUploadPreview() {
    await waitFor(async () => {
      const status = await runInPage(this.webContents, () => {
        const input = document.querySelector('input[data-watermark-lab-upload="1"]');
        const hasSelectedFile = Boolean(input?.files?.length);
        const hasVisiblePreview = [...document.images].some((image) => {
          const rect = image.getBoundingClientRect();
          return rect.width >= 80 && rect.height >= 60 && rect.top > innerHeight * 0.35;
        });
        return hasSelectedFile || hasVisiblePreview;
      });
      return status;
    }, {
      timeout: 20_000,
      interval: 400,
      isCancelled: this.isCancelled,
      message: '图片已选择，但豆包没有显示上传预览'
    });
    await sleep(400);
  }

  startNetworkCapture(excludedUrls) {
    const candidates = new Map();
    const excluded = new Set(excludedUrls);
    const excludedAssetKeys = new Set([...excluded].map(imageAssetKey).filter(Boolean));
    const webContentsId = this.webContents.id;
    const hub = sessionCaptureHub(this.session);
    const handler = (details) => {
      try {
        // 只收集本窗口的请求，避免并行任务之间串图；session 级 fetch 没有 webContentsId，一并排除
        if (details.webContentsId !== webContentsId) return;
        if (details.resourceType !== 'image' || details.statusCode < 200 || details.statusCode >= 400) return;
        if (excluded.has(details.url)) return;
        const assetKey = imageAssetKey(details.url);
        if (assetKey && excludedAssetKeys.has(assetKey)) return;
        const contentType = responseHeader(details.responseHeaders, 'content-type');
        const contentLength = Number(responseHeader(details.responseHeaders, 'content-length')) || 0;
        if (contentType && !contentType.toLowerCase().startsWith('image/')) return;
        if (contentLength && contentLength < 18_000) return;
        candidates.set(details.url, {
          url: details.url,
          source: 'network',
          contentType,
          contentLength,
          seenAt: Date.now()
        });
      } catch {
        // A malformed response must never crash Electron's main process.
      }
    };
    hub.handlers.add(handler);
    return {
      candidates,
      stop: () => hub.handlers.delete(handler)
    };
  }

  // 无水印原图直取（doubao-no-watermark 方案）：通过 CDP Network 域旁路读取
  // chat/completion 的 SSE 响应体，提取服务端直接返回的 image_ori_raw 无水印原图地址。
  // 不注入页面、不改动页面任何行为；抓不到时调用方回退原有白边裁切管线。
  startApiRawCapture() {
    // 测试钩子：e2e 需要强制走「降级重发」链路时，用 DWL_DISABLE_API_RAW=1 关掉接口拦截
    if (process.env.DWL_DISABLE_API_RAW === '1') {
      return { candidates: new Map(), pendingCount: () => 0, stop() {} };
    }
    const found = new Map();
    const pending = new Set();
    const debuggerApi = this.webContents.debugger;
    try {
      if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    } catch { /* 已被其他模块附加 */ }
    const onMessage = (_event, method, params) => {
      try {
        if (method === 'Network.responseReceived') {
          const url = params?.response?.url || '';
          if (url.includes('chat/completion')) pending.add(params.requestId);
          return;
        }
        if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
          const requestId = params.requestId;
          pending.delete(requestId);
          debuggerApi.sendCommand('Network.getResponseBody', { requestId })
            .then((body) => {
              const text = body?.base64Encoded
                ? Buffer.from(body.body || '', 'base64').toString('utf8')
                : body?.body;
              if (!text) return;
              const before = found.size;
              harvestSseText(text, found);
              if (found.size > before) this.onProgress('已拦截到豆包返回的无水印原图');
            })
            .catch(() => { /* 响应体不可用（流已释放等），回退旧管线 */ });
        }
      } catch { /* 单条消息异常不影响捕获 */ }
    };
    debuggerApi.on('message', onMessage);
    debuggerApi.sendCommand('Network.enable').catch(() => {});
    return {
      candidates: found,
      pendingCount: () => pending.size,
      stop: () => {
        debuggerApi.removeListener('message', onMessage);
        pending.clear();
      }
    };
  }

  async enterPrompt(prompt) {
    this.onProgress('正在填写处理指令');
    const result = await waitFor(
      async () => {
        const value = await runInPage(this.webContents, setComposerText, prompt);
        return value?.ok && value?.value ? value : false;
      },
      {
        timeout: 15_000,
        interval: 700,
        isCancelled: this.isCancelled,
        message: '没有找到豆包的消息输入框'
      }
    );
    if (!result.ok || !result.value) throw new Error('无法把提示词写入豆包输入框');
  }

  async sendPrompt() {
    const result = await runInPage(this.webContents, clickSendButton);
    if (result.clicked) return;
    this.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
    this.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
  }

  async waitForGeneratedImage(baselineUrls, networkCapture, timeoutMs = 240_000, {
    baselineFinishedReplies = 0,
    baselineFollowUps = 0,
    baselineTailText = '',
    promptText = '',
    noImageGraceMs = DEFAULT_NO_IMAGE_GRACE_MS,
    apiRawCapture = null
  } = {}) {
    this.onProgress('豆包正在重绘图片');
    const started = Date.now();
    let verificationWaitMs = 0;
    let firstCandidateAt = 0;
    let stableSince = 0;
    let lastSignature = '';
    let idleSince = 0;
    let sawGenerating = false;
    let sawStreaming = false;
    let sawReplyFinished = false;
    let generationDoneSince = 0;
    let latestDomCandidates = [];
    let lastTailText = baselineTailText;
    let tailStableSince = Date.now();
    const baselineAssetKeys = new Set([...baselineUrls].map(imageAssetKey).filter(Boolean));
    const promptTailEcho = String(promptText || '').replace(/\s+/g, '').slice(-24);

    while (Date.now() - started - verificationWaitMs < timeoutMs) {
      assertNotCancelled(this.isCancelled);
      assertNotRestarted(this.shouldRestart);
      const verification = await this.waitForVerificationIfNeeded();
      verificationWaitMs += verification.waitedMs;
      const snapshot = await runInPage(this.webContents, pageImageSnapshot);
      latestDomCandidates = snapshot.images
        .filter((image) => !image.userMessage)
        .filter((image) => !image.baseline && !baselineUrls.has(image.url))
        .filter((image) => {
          const key = imageAssetKey(image.url);
          return !key || !baselineAssetKeys.has(key);
        })
        .filter((image) => image.width >= 400 && image.height >= 250 && image.width * image.height >= 150_000)
        .map((image) => ({ ...image, source: 'dom' }));

      const networkCandidates = [...networkCapture.candidates.values()];
      const generatedNetworkCandidates = networkCandidates.filter((candidate) =>
        /\/rc_gen_image\/|downsize_watermark|(?:^|[/_-])(?:generated|aigc|generate)(?:[/_.-]|$)/i.test(candidate.url)
      );
      const candidateCount = latestDomCandidates.length + generatedNetworkCandidates.length;
      const apiRawCandidates = apiRawCapture ? [...apiRawCapture.candidates.values()] : [];
      const apiPending = apiRawCapture ? apiRawCapture.pendingCount() : 0;
      const totalCandidates = candidateCount + apiRawCandidates.length;
      // 已出现在页面上但还没下载完成的生成图：说明图片正在路上，不能按“没生成”处理
      const pendingImageCount = snapshot.images
        .filter((image) => image.pending)
        .filter((image) => !image.userMessage)
        .filter((image) => !image.baseline && !baselineUrls.has(image.url))
        .filter((image) => {
          const key = imageAssetKey(image.url);
          return !key || !baselineAssetKeys.has(key);
        })
        .filter((image) => image.displayWidth >= 80 && image.displayHeight >= 60)
        .length;
      if (totalCandidates && !firstCandidateAt) firstCandidateAt = Date.now();
      const signature = `${apiRawCandidates.length}::${latestDomCandidates.map((item) => item.url).join('|')}::${generatedNetworkCandidates.map((item) => item.url).join('|')}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
      }

      const stableFor = Date.now() - stableSince;
      const visibleFor = firstCandidateAt ? Date.now() - firstCandidateAt : 0;
      // 有 chat/completion 仍在流式返回时不收兵：无水印原图（api-raw）在流结束时才落袋
      if (totalCandidates && !snapshot.generating && !apiPending && stableFor > 6500 && visibleFor > 5500) {
        return [...apiRawCandidates, ...latestDomCandidates, ...generatedNetworkCandidates];
      }

      // 尾部文本持续变化说明回复正在流式输出；用户消息回显还停在尾部时除外（那是我们自己发的内容）
      const tailText = String(snapshot.tailText || '');
      const tailNormalized = tailText.replace(/\s+/g, '');
      const promptEchoNearTail = promptTailEcho.length >= 8 && tailNormalized.slice(-140).includes(promptTailEcho);
      if (tailText !== lastTailText) {
        if (!promptEchoNearTail && tailNormalized) sawStreaming = true;
        lastTailText = tailText;
        tailStableSince = Date.now();
      }
      const tailQuietMs = Date.now() - tailStableSince;

      if (snapshot.generating) sawGenerating = true;
      if (Number(snapshot.finishedReplies) > baselineFinishedReplies) sawReplyFinished = true;
      if (Number(snapshot.followUps) > baselineFollowUps) sawReplyFinished = true;
      if (totalCandidates || pendingImageCount || snapshot.generating || apiPending) {
        idleSince = 0;
        generationDoneSince = 0;
      } else {
        if (!idleSince) idleSince = Date.now();
        // 回复结束按钮/联想问题出现，或流式输出停止超过 4 秒，都说明本轮生成已结束
        const replySettled = sawReplyFinished || ((sawGenerating || sawStreaming) && tailQuietMs > 4_000);
        if (replySettled && !generationDoneSince) {
          generationDoneSince = Date.now();
          this.onProgress(`豆包回复已结束，继续等待图片出现（最长 ${Math.round(noImageGraceMs / 1000)} 秒）`);
        }
      }

      if (!totalCandidates && !pendingImageCount && generationDoneSince && Date.now() - generationDoneSince > noImageGraceMs) {
        throw noImageGeneratedError(snapshot.assistantTailText || snapshot.tailText, promptText);
      }
      if (!totalCandidates && Date.now() - started > 35_000 && /抱歉|无法处理|不能完成|未能生成/.test(snapshot.tailText)) {
        const textOnlyError = new Error('豆包返回了文字提示，但没有生成图片；可调整提示词后重试');
        textOnlyError.code = 'NO_IMAGE_GENERATED';
        throw textOnlyError;
      }
      if (!totalCandidates && idleSince && Date.now() - started > 90_000 && Date.now() - idleSince > 45_000) {
        throw noImageGeneratedError(snapshot.assistantTailText || snapshot.tailText, promptText);
      }
      await sleep(1400);
    }

    const fallbackNetworkCandidates = [...networkCapture.candidates.values()].filter((candidate) =>
      /\/rc_gen_image\/|downsize_watermark|(?:^|[/_-])(?:generated|aigc|generate)(?:[/_.-]|$)/i.test(candidate.url)
    );
    const fallbackApiRaw = apiRawCapture ? [...apiRawCapture.candidates.values()] : [];
    const fallback = [...fallbackApiRaw, ...latestDomCandidates, ...fallbackNetworkCandidates];
    if (fallback.length) return fallback;
    throw new Error('等待豆包生成图片超时');
  }

  async processImage({ filePath, prompt, newConversation = true, conversationId = '', imageWaitSeconds = 0 }) {
    assertNotCancelled(this.isCancelled);
    await this.waitForVerificationIfNeeded();
    // 登录检查放在任何会话导航之前：真实退出时不要先去点“新对话”然后报普通 DOM 错误，
    // 必须抛出 LOGIN_RECOVERY_REQUIRED 交给主调度自动恢复。
    await this.requireAuthenticated();
    let resumed = false;
    if (conversationId) {
      resumed = await this.openConversation(conversationId).catch(() => false);
    }
    // 历史对话接不上（已删除等）时也开新对话，避免内容发进无关会话
    if (!resumed && (newConversation || conversationId)) await this.freshConversation();
    // 导航后再快速确认一次，覆盖“打开历史会话时刚好跳登录页”的边界情况。
    await this.requireAuthenticated();

    await this.attachFile(filePath);
    // 上传完成后再填提示词：实测豆包在传图期间向输入框写入文字可能触发重渲染、冲掉未完成的附件
    await this.waitForUploadPreview();
    await this.waitForVerificationIfNeeded();
    await runInPage(this.webContents, markExistingImages);
    const baseline = await runInPage(this.webContents, pageImageSnapshot);
    const baselineUrls = new Set(baseline.images.map((image) => image.url));
    const capture = this.startNetworkCapture(baselineUrls);
    // 无水印原图直取捕获：与页面候选并行，抓不到时自然回退白边裁切管线
    const apiRawCapture = this.startApiRawCapture();
    try {
      await this.enterPrompt(prompt);
      await this.waitForVerificationIfNeeded();
      await this.sendPrompt();
      // 新会话的 ID 要等首条消息发出后才出现在 URL 里，稍等片刻再读取
      let capturedConversationId = conversationId;
      for (let attempt = 0; attempt < 6 && !capturedConversationId; attempt += 1) {
        await sleep(500);
        const url = await runInPage(this.webContents, () => location.href).catch(() => '');
        capturedConversationId = conversationIdFromUrl(url);
      }
      try {
        const candidates = await this.waitForGeneratedImage(baselineUrls, capture, undefined, {
          baselineFinishedReplies: Number(baseline.finishedReplies) || 0,
          baselineFollowUps: Number(baseline.followUps) || 0,
          baselineTailText: baseline.tailText || '',
          promptText: prompt,
          noImageGraceMs: imageWaitSeconds > 0 ? imageWaitSeconds * 1000 : DEFAULT_NO_IMAGE_GRACE_MS,
          apiRawCapture
        });
        // apiRawHit 供调用方决定是否需要「加隔离带重发」的降级轮
        const apiRawHit = candidates.some((candidate) => candidate.source === 'api-raw');
        return { candidates, conversationId: capturedConversationId, apiRawHit };
      } catch (error) {
        if (capturedConversationId && !error.conversationId) error.conversationId = capturedConversationId;
        throw error;
      }
    } finally {
      capture.stop();
      apiRawCapture.stop();
    }
  }

  async inspectWatermarkResidual({ filePath, prompt, timeoutMs = 90_000 }) {
    assertNotCancelled(this.isCancelled);
    await this.waitForVerificationIfNeeded();
    await this.requireAuthenticated();
    await this.freshConversation();
    await this.requireAuthenticated();

    this.onProgress('正在全图复检残留水印');
    await this.attachFile(filePath);
    await this.waitForUploadPreview();
    await this.waitForVerificationIfNeeded();
    const baseline = await runInPage(this.webContents, pageImageSnapshot);
    await this.enterPrompt(prompt);
    await this.waitForVerificationIfNeeded();
    await this.sendPrompt();

    const started = Date.now();
    let lastText = '';
    let stableSince = Date.now();
    let lastParsed = null;
    while (Date.now() - started < timeoutMs) {
      assertNotCancelled(this.isCancelled);
      assertNotRestarted(this.shouldRestart);
      await this.waitForVerificationIfNeeded();
      const snapshot = await runInPage(this.webContents, pageImageSnapshot);
      const text = String(snapshot.assistantTailText || '').trim();
      if (text !== lastText) {
        lastText = text;
        stableSince = Date.now();
        lastParsed = parseWatermarkAudit(text);
      }
      const finished = Number(snapshot.finishedReplies) > Number(baseline.finishedReplies || 0)
        || Number(snapshot.followUps) > Number(baseline.followUps || 0);
      const settled = !snapshot.generating && (finished || Date.now() - stableSince > 2800);
      if (settled && lastParsed) return lastParsed;
      if (settled && text && Date.now() - stableSince > 6500) {
        throw new Error('残留水印复检返回格式异常，未能解析检测结果');
      }
      await sleep(900);
    }
    throw new Error('残留水印复检超时');
  }

  async downloadGeneratedFromEditor(nativeImage, timeoutMs = 60_000) {
    const temporaryPath = path.join(os.tmpdir(), `watermark-lab-${Date.now()}-${crypto.randomUUID()}.png`);
    let activeItem = null;
    let timer = null;
    let listener = null;
    let rejectPending = null;
    const download = new Promise((resolve, reject) => {
      rejectPending = reject;
      listener = (_event, item, originWebContents) => {
        if (originWebContents && originWebContents.id !== this.webContents.id) return;
        this.session.removeListener('will-download', listener);
        listener = null;
        activeItem = item;
        item.setSavePath(temporaryPath);
        item.once('done', (_doneEvent, state) => {
          if (state === 'completed') resolve(temporaryPath);
          else reject(new Error(`豆包原生保存未完成（${state}）`));
        });
      };
      this.session.on('will-download', listener);
      timer = setTimeout(() => {
        activeItem?.cancel();
        reject(new Error('等待豆包原生保存超时'));
      }, timeoutMs);
    });

    try {
      this.onProgress('正在通过豆包原生保存导出生成图');
      let clicked;
      try {
        clicked = await runInPage(this.webContents, clickEditorDownload);
      } catch (error) {
        rejectPending?.(error);
      }
      if (!clicked?.clicked) {
        if (listener) this.session.removeListener('will-download', listener);
        listener = null;
        rejectPending?.(new Error('没有找到豆包生成图的保存按钮'));
      }
      await download;
      const buffer = await fs.readFile(temporaryPath);
      const image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) throw new Error('豆包原生保存返回的图片无法读取');
      const size = image.getSize();
      if (size.width < 480 || size.height < 320) throw new Error('豆包原生保存返回的图片分辨率过低');
      return {
        buffer,
        image,
        width: size.width,
        height: size.height,
        contentType: 'image/png',
        source: 'editor-download',
        kind: 'doubao-editor-generated-watermarked',
        likelyOriginal: false
      };
    } finally {
      clearTimeout(timer);
      if (listener) this.session.removeListener('will-download', listener);
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async captureLatestGeneratedCanvas(nativeImage, candidates = []) {
    await this.waitForVerificationIfNeeded();
    this.onProgress('链接不可用，正在从豆包高清预览导出');
    const candidateUrls = candidates.map((candidate) => typeof candidate === 'string' ? candidate : candidate?.url).filter(Boolean);
    const opened = await runInPage(this.webContents, openLatestGeneratedPreview, candidateUrls);
    if (!opened?.opened) {
      throw new Error(`没有找到可打开的豆包生成结果（候选链接 ${opened?.candidateCount || candidateUrls.length} 个）`);
    }

    try {
      await waitFor(
        () => runInPage(this.webContents, editorCanvasState, false),
        {
          timeout: 30_000,
          interval: 700,
          isCancelled: this.isCancelled,
          message: '豆包高清预览没有加载完成'
        }
      );
      await sleep(900);

      try {
        return await this.downloadGeneratedFromEditor(nativeImage);
      } catch (downloadError) {
        this.onProgress(`豆包原生保存不可用，改用高清画布导出：${downloadError.message}`);
      }

      const canvas = await runInPage(this.webContents, editorCanvasState, true);
      if (canvas?.dataUrl?.startsWith('data:image/') && canvas.dataUrl.length > 20_000) {
        const buffer = Buffer.from(canvas.dataUrl.split(',', 2)[1], 'base64');
        const image = nativeImage.createFromBuffer(buffer);
        if (!image.isEmpty()) {
          const size = image.getSize();
          if (size.width >= 480 && size.height >= 320) {
            return {
              buffer,
              image,
              width: size.width,
              height: size.height,
              contentType: 'image/png',
              source: 'canvas',
              kind: 'canvas-generated-watermarked',
              likelyOriginal: false
            };
          }
        }
      }

      if (!canvas?.rect) throw new Error(canvas?.error || '无法读取豆包高清画布');
      const screenshot = await this.webContents.capturePage(canvas.rect);
      if (screenshot.isEmpty()) throw new Error(canvas?.error || '无法截取豆包高清画布');
      const buffer = screenshot.toPNG();
      const size = screenshot.getSize();
      if (size.width < 480 || size.height < 320) throw new Error('豆包画布截图分辨率过低');
      return {
        buffer,
        image: screenshot,
        width: size.width,
        height: size.height,
        contentType: 'image/png',
        source: 'canvas-screenshot',
        kind: 'canvas-generated-watermarked',
        likelyOriginal: false
      };
    } finally {
      if (!this.webContents.isDestroyed()) {
        this.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESCAPE' });
        this.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESCAPE' });
        await sleep(350);
      }
    }
  }
}

module.exports = {
  DOUBAO_CHAT_URL,
  DoubaoAutomation,
  conversationIdFromUrl,
  harvestImageRawUrls,
  harvestSseText,
  imageAssetKey,
  noImageGeneratedError,
  classifyLoginState,
  parseWatermarkAudit,
  pageLoginStatus,
  pageVerificationState,
  responseHeader
};
