'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DoubaoAutomation, classifyLoginState, conversationIdFromUrl, imageAssetKey, noImageGeneratedError, parseWatermarkAudit, responseHeader, settledNoImageGraceMs } = require('../src/doubao-automation');
const { buildSameConversationWatermarkAuditPrompt } = require('../src/prompt');

test('解析新版 Electron 的响应头对象', () => {
  assert.equal(responseHeader({
    'content-type': ['image/png'],
    'Content-Length': ['12345']
  }, 'content-type'), 'image/png');
  assert.equal(responseHeader({
    'content-type': ['image/png'],
    'Content-Length': ['12345']
  }, 'content-length'), '12345');
});

test('兼容旧版 Electron 的响应头数组', () => {
  assert.equal(responseHeader([
    { name: 'Content-Type', value: 'image/jpeg' }
  ], 'content-type'), 'image/jpeg');
});

test('兼容标准 Headers 对象和空响应头', () => {
  assert.equal(responseHeader(new Headers({ 'content-type': 'image/webp' }), 'CONTENT-TYPE'), 'image/webp');
  assert.equal(responseHeader(null, 'content-type'), '');
});

test('同一图片的不同 CDN 主机和签名会得到相同资源指纹', () => {
  const first = 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/source.png~tplv-a9rns2rl98-image.png?x-signature=one';
  const second = 'https://p26-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/source.png~tplv-a9rns2rl98-image.png?x-signature=two';
  assert.equal(imageAssetKey(first), imageAssetKey(second));
  assert.equal(imageAssetKey(first), '/tos-cn-i-a9rns2rl98/source.png');
});

test('上传原图与生成结果拥有不同资源指纹', () => {
  const source = 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/source.png~tplv-a9rns2rl98-image.png';
  const generated = 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/result.jpeg~tplv-a9rns2rl98-downsize_watermark.png';
  assert.notEqual(imageAssetKey(source), imageAssetKey(generated));
});

test('未生成图片的报错会提示调整提示词并附上豆包回复摘要', () => {
  const error = noImageGeneratedError('这个请求我暂时无法完成，建议你换个描述试试');
  assert.match(error.message, /提示词可能不合适/);
  assert.match(error.message, /换个描述/);
  assert.equal(error.code, 'NO_IMAGE_GENERATED');
  assert.equal(noImageGeneratedError('').message.includes('豆包回复：“'), false);
});

test('从豆包页面地址解析会话 ID', () => {
  assert.equal(conversationIdFromUrl('https://www.doubao.com/chat/7321987654321098'), '7321987654321098');
  assert.equal(conversationIdFromUrl('https://www.doubao.com/chat/7321987654321098?from=share'), '7321987654321098');
  assert.equal(conversationIdFromUrl('https://www.doubao.com/chat/'), '');
  assert.equal(conversationIdFromUrl('https://www.doubao.com/chat'), '');
  assert.equal(conversationIdFromUrl(''), '');
});

test('未生成图片的报错只保留豆包输出，剔除用户发送的内容', () => {
  const error = noImageGeneratedError('移除图片水印 抱歉，这个请求我无法完成，请换个描述', '移除图片水印');
  assert.equal(error.message.includes('移除图片水印'), false);
  assert.match(error.message, /抱歉，这个请求我无法完成/);
  const emptied = noImageGeneratedError('移除图片水印', '移除图片水印');
  assert.equal(emptied.message.includes('豆包回复：“'), false);
});

test('剔除发送内容时不误伤包含该词的豆包回复', () => {
  const error = noImageGeneratedError('你好呀，有什么我可以帮你的吗？', '你好');
  assert.match(error.message, /你好呀，有什么我可以帮你的吗？/);
});

test('未生成图片的报错截取豆包回复的开头部分', () => {
  const long = `开头内容${'中'.repeat(200)}结尾内容`;
  const error = noImageGeneratedError(long);
  assert.match(error.message, /开头内容/);
  assert.equal(error.message.includes('结尾内容'), false);
});


test('残留水印复检可解析多种坐标字段并把百分比归一化', () => {
  const audit = parseWatermarkAudit('```json\n{"hasResidual":true,"confidence":94,"regions":[{"left":12,"top":20,"right":48,"bottom":30,"confidence":91,"kind":"text"}]}\n```');
  assert.equal(audit.hasResidual, true);
  assert.equal(audit.confidence, 0.94);
  assert.equal(audit.regions.length, 1);
  assert.deepEqual(audit.regions[0], {
    x: 0.12,
    y: 0.2,
    w: 0.36,
    h: 0.09999999999999998,
    confidence: 0.91,
    kind: 'text'
  });
});

test('残留水印复检对 clean JSON 返回空区域', () => {
  const audit = parseWatermarkAudit('{"hasResidual":false,"confidence":0.98,"regions":[]}');
  assert.deepEqual(audit, { hasResidual: false, confidence: 0.98, regions: [] });
});

test('残留水印复检遇到非 JSON 文本返回 null，不误触发自动补修', () => {
  assert.equal(parseWatermarkAudit('这张图看起来已经没有水印了'), null);
});


test('登录判断优先相信可实际聊天/上传能力，不再要求头像必须出现', () => {
  const composerOnly = classifyLoginState({
    hasLogin: false,
    hasAccount: false,
    hasComposer: true,
    hasUpload: false,
    isChatUrl: true,
    url: 'https://www.doubao.com/chat/'
  }, false);
  assert.equal(composerOnly.state, 'authenticated');
  assert.equal(composerOnly.loggedIn, true);

  const uploadOnly = classifyLoginState({
    hasLogin: false,
    hasAccount: false,
    hasComposer: false,
    hasUpload: true,
    isChatUrl: true,
    url: 'https://www.doubao.com/chat/'
  }, false);
  assert.equal(uploadOnly.state, 'authenticated');
});

test('明确登录入口且没有聊天能力时判定为退出，即使残留 Cookie 仍存在', () => {
  const status = classifyLoginState({
    hasLogin: true,
    hasAccount: false,
    hasComposer: false,
    hasUpload: false,
    isChatUrl: true,
    isLoginPage: false,
    url: 'https://www.doubao.com/chat/'
  }, true);
  assert.equal(status.state, 'logged-out');
  assert.equal(status.loggedIn, false);
});

test('只有 Cookie、页面信号缺失时保持 uncertain，交给恢复流程复查而不是直接判失败', () => {
  const status = classifyLoginState({}, true);
  assert.equal(status.state, 'uncertain');
  assert.equal(status.loggedIn, false);
  assert.equal(status.cookieHint, true);
});


test('已销毁 BrowserWindow 不再冒出 Electron 原始 Object has been destroyed，而是标准 WORKER_DESTROYED', () => {
  assert.throws(
    () => new DoubaoAutomation({ isDestroyed: () => true }),
    (error) => {
      assert.equal(error.code, 'WORKER_DESTROYED');
      assert.match(error.message, /豆包工作窗口已失效/);
      return true;
    }
  );
});


test('明确回复已结束后，无图等待最多 20 秒；生成状态不明确时保留用户设置', () => {
  assert.equal(settledNoImageGraceMs(60_000, true), 20_000);
  assert.equal(settledNoImageGraceMs(15_000, true), 15_000);
  assert.equal(settledNoImageGraceMs(60_000, false), 60_000);
});

test('健康登录状态在 15 秒内复用，强制检查仍会重新确认', async () => {
  const automation = new DoubaoAutomation({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      session: {}
    }
  });
  let checks = 0;
  automation.confirmLoginStatus = async () => {
    checks += 1;
    return { state: 'authenticated', loggedIn: true };
  };
  await automation.requireAuthenticated();
  await automation.requireAuthenticated();
  assert.equal(checks, 1);
  await automation.requireAuthenticated({ force: true });
  assert.equal(checks, 2);
});


test('同会话残留复检提示词明确锁定刚生成的最后一张结果图', () => {
  const prompt = buildSameConversationWatermarkAuditPrompt({ language: 'zh' });
  assert.match(prompt, /刚刚生成的最后一张处理结果图/);
  assert.match(prompt, /不要检查用户最初上传的原图/);
  assert.match(prompt, /不要生成新图片/);
  assert.match(prompt, /hasResidual/);
});

test('DoubaoAutomation 提供同会话复检能力', () => {
  assert.equal(typeof DoubaoAutomation.prototype.inspectLatestGeneratedResidual, 'function');
});
