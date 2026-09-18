'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, session, systemPreferences, Tray } = require('electron');
const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { computeDiffStats, verdictForStats, buildHeatmap } = require('./qc-check');
const { hueOfColor, retintPixels } = require('./theme-icon');
const { DoubaoAutomation, DOUBAO_CHAT_URL } = require('./doubao-automation');
const {
  downloadBestImage,
  isExactSourceImage,
  prepareManualMarkedUpload,
  preparePaddedUpload,
  saveProcessedImage,
  watermarkRegionsToStrokes
} = require('./image-pipeline');
const { buildManualEditPrompt, buildPrompt, buildWatermarkAuditPrompt, DEFAULT_PROMPT, DEFAULT_PROMPT_EN, MANUAL_EDIT_PROMPT, MANUAL_EDIT_PROMPT_EN } = require('./prompt');
const { overwriteGuard, replaceOriginalSafely } = require('./original-overwrite');
const {
  MAX_AUTO_RETRIES,
  exhaustedRetryMessage,
  isDestroyedObjectError,
  normalizeTaskError,
  retryProgressMessage,
  shouldAutoRetryTaskError,
  workerDestroyedError
} = require('./task-retry');
const { writeZipFile } = require('./zip-writer');

const DOUBAO_PARTITION = 'persist:watermark-lab-doubao';
const APP_ICON_PATH = path.join(__dirname, 'assets', 'app-icon.png');
const APP_DISPLAY_NAME = '水印清理工作台';
// 鸿蒙（OpenHarmony）平台标记：窗口框架、托盘、更新、默认目录等按平台差异走专门分支
const IS_OHOS = process.platform === 'openharmony';
// Dock 悬停与系统各处显示应用名（开发模式下默认显示 Electron）
app.setName(APP_DISPLAY_NAME);
// setName 会改变 userData 默认位置；若旧目录已存在则钉回去，避免设置、队列与豆包登录态丢失
// （鸿蒙上 appData 概念不存在，getPath 可能抛异常，做好防御）
let LEGACY_USER_DATA = null;
try { LEGACY_USER_DATA = path.join(app.getPath('appData'), 'doubao-watermark-lab'); } catch { /* 平台无 appData */ }
try {
  if (LEGACY_USER_DATA && fsSync.existsSync(LEGACY_USER_DATA)) app.setPath('userData', LEGACY_USER_DATA);
} catch { /* 保留默认路径 */ }
const AUTOMATION_SAFETY_VERSION = 1;
const CROP_STRATEGY_VERSION = 4;
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif', '.heic', '.heif']);
const THEME_MODES = new Set(['auto', 'light', 'dark']);
const PALETTE_COLORS = Object.freeze({
  forest: '#246b55',
  ocean: '#28739a',
  violet: '#745ca7',
  sunset: '#b9663e',
  graphite: '#53636a'
});
const COLOR_PALETTES = new Set([...Object.keys(PALETTE_COLORS), 'custom']);
const STABLE_PROCESSING_SETTINGS = Object.freeze({
  preferOriginal: true,
  cropMode: 'fallback',
  addPaddingBeforeUpload: true,
  newConversation: false
});
const PARALLEL_WORKER_COUNT = 3;
const MAX_CONCURRENT_LIMIT = 8;
const DEFAULT_SETTINGS = {
  outputDirectory: '',
  prompt: DEFAULT_PROMPT,
  manualEditPrompt: MANUAL_EDIT_PROMPT,
  ...STABLE_PROCESSING_SETTINGS,
  cropEdge: 'top',
  cropPercent: 10,
  cropCompensationPercent: 0.5,
  intervalSeconds: 30,
  imageWaitSeconds: 60,
  overwriteOriginal: false,
  overwriteOriginalConfirmed: false,
  parallelProcessing: true,
  showBrowserWindow: false,
  themeMode: 'auto',
  colorPalette: 'forest',
  themeColor: PALETTE_COLORS.forest,
  language: 'zh',
  automationSafetyVersion: AUTOMATION_SAFETY_VERSION,
  cropStrategyVersion: CROP_STRATEGY_VERSION
};

// 主进程侧文案的中英文切换（窗口标题、系统对话框、通知、托盘）。
// 后端进度/错误消息保持中文原样发出，由 renderer 在展示时用同一份词典翻译，
// 主进程逻辑与测试不受语言影响；豆包窗口标题里的进度文案用 rendererI18n 就地翻译
const rendererI18n = require('./renderer/i18n');
let currentLanguage = 'zh';
const mt = (zh, en) => (currentLanguage === 'en' ? en : zh);
const setAppLanguage = (language) => {
  currentLanguage = language === 'en' ? 'en' : 'zh';
  rendererI18n.init(currentLanguage);
};

let mainWindow;
let doubaoWindow;
// 鸿蒙托盘（窗口显隐的系统前置条件，需长期持有）
let ohosTray = null;
let previewWindow;
let manualWindow;
let advancedWindow;
let loginTimer;
let loginFlowActive = false;
// 批处理与涂抹重绘都支持并发：activeBatchCount 跟踪进行中的任务数，每个批次持有独立取消标记；
// busyWindows 记录被批次占用的豆包窗口
let activeBatchCount = 0;
let batchSeq = 0;
const activeCancelRefs = new Set();
const busyWindows = new Set();
// 全局在用的历史会话 ID：同一会话不能被两个任务同时写入。
// 必须跨批次共享——「重新生成」与「涂抹重绘」同一张图是两个独立批次，也会指向同一会话
const inUseConversations = new Set();
// 安全验证是会话级风控：多线程下多个窗口会同时弹验证，让用户一个个做体验极差。
// 全局只选一个「领头」窗口弹出验证（owner 记录领头任务的令牌），其余任务静默暂停等待；
// 领头完成验证后 verificationEpoch 递增广播重启信号，所有被波及的任务自动整体重跑
const verificationGate = { owner: null };
const verificationEpoch = { value: 0 };
// 登录恢复也做成全局单领头：并发任务同时发现登录异常时只允许一个窗口执行恢复/登录，
// 其他任务等待同一 Promise；恢复成功后 loginRecoveryEpoch 递增，通知所有受影响任务从头重跑。
const loginRecoveryGate = { owner: null, promise: null };
const loginRecoveryEpoch = { value: 0 };
let tempFileSeq = 0;

// 并发批次可能同时写同一文件，临时文件名必须唯一，避免 rename 竞态
function uniqueTemporaryPath(targetPath) {
  tempFileSeq += 1;
  return `${targetPath}.${process.pid}.${Date.now()}.${tempFileSeq}.tmp`;
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function queueRecordsPath() {
  return path.join(app.getPath('userData'), 'queue-records.json');
}

// 鸿蒙没有公共图片目录的访问权限（需 ACL 申请），默认输出到应用沙箱（文件管理器可见）；
// mac/win 默认输出到图片目录
function defaultOutputDirectory() {
  return IS_OHOS
    ? path.join(app.getPath('userData'), 'Watermark Lab')
    : path.join(app.getPath('pictures'), 'Watermark Lab');
}

async function loadSettings() {
  const defaults = {
    ...DEFAULT_SETTINGS,
    outputDirectory: defaultOutputDirectory()
  };
  let settings;
  try {
    const saved = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    settings = sanitizeSettings({
      ...defaults,
      ...saved,
      themeColor: saved.themeColor || PALETTE_COLORS[saved.colorPalette] || defaults.themeColor
    });
  } catch {
    // 首次启动（settings.json 不存在）也要走 sanitize，补齐 maxConcurrentTasks 等派生字段
    settings = sanitizeSettings(defaults);
  }
  setAppLanguage(settings.language);
  return settings;
}

function sanitizeSettings(input = {}) {
  const language = input.language === 'en' ? 'en' : 'zh';
  const defaultPrompt = language === 'en' ? DEFAULT_PROMPT_EN : DEFAULT_PROMPT;
  const defaultManualPrompt = language === 'en' ? MANUAL_EDIT_PROMPT_EN : MANUAL_EDIT_PROMPT;
  const colorPalette = COLOR_PALETTES.has(input.colorPalette) ? input.colorPalette : 'forest';
  const fallbackThemeColor = PALETTE_COLORS[colorPalette] || PALETTE_COLORS.forest;
  const themeColor = typeof input.themeColor === 'string' && /^#[0-9a-f]{6}$/i.test(input.themeColor)
    ? input.themeColor.toLowerCase()
    : fallbackThemeColor;
  const overwriteOriginalConfirmed = input.overwriteOriginalConfirmed === true;
  return {
    outputDirectory: typeof input.outputDirectory === 'string' && input.outputDirectory
      ? path.resolve(input.outputDirectory)
      : defaultOutputDirectory(),
    prompt: typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt.trim().slice(0, 4000) : defaultPrompt,
    manualEditPrompt: typeof input.manualEditPrompt === 'string' && input.manualEditPrompt.trim()
      ? input.manualEditPrompt.trim().slice(0, 4000)
      : defaultManualPrompt,
    ...STABLE_PROCESSING_SETTINGS,
    cropEdge: input.cropEdge === 'bottom' ? 'bottom' : 'top',
    cropPercent: Math.min(25, Math.max(10, Number(input.cropPercent) || 10)),
    cropCompensationPercent: Math.min(3, Math.max(0, Number(input.cropCompensationPercent) || 0)),
    intervalSeconds: Math.min(600, Math.max(0, Number.isFinite(Number(input.intervalSeconds)) ? Math.round(Number(input.intervalSeconds)) : 30)),
    imageWaitSeconds: Math.min(300, Math.max(5, Number.isFinite(Number(input.imageWaitSeconds)) ? Math.round(Number(input.imageWaitSeconds)) : 60)),
    overwriteOriginalConfirmed,
    overwriteOriginal: input.overwriteOriginal === true && overwriteOriginalConfirmed,
    parallelProcessing: input.parallelProcessing === true,
    maxConcurrentTasks: Math.min(MAX_CONCURRENT_LIMIT, Math.max(1, Math.round(Number(input.maxConcurrentTasks) || PARALLEL_WORKER_COUNT))),
    showBrowserWindow: input.showBrowserWindow !== false,
    themeMode: THEME_MODES.has(input.themeMode) ? input.themeMode : 'auto',
    colorPalette,
    themeColor,
    language,
    automationSafetyVersion: AUTOMATION_SAFETY_VERSION,
    cropStrategyVersion: CROP_STRATEGY_VERSION
  };
}

async function saveSettings(settings) {
  const sanitized = sanitizeSettings(settings);
  if (sanitized.language !== currentLanguage) {
    // 切换语言时提示词整体重置为对应语言的默认版本：提示词是发给豆包的指令，
    // 自定义文本无法自动翻译，跟随语言给出对应语言的完整默认（切回时同样重置）
    sanitized.prompt = sanitized.language === 'en' ? DEFAULT_PROMPT_EN : DEFAULT_PROMPT;
    sanitized.manualEditPrompt = sanitized.language === 'en' ? MANUAL_EDIT_PROMPT_EN : MANUAL_EDIT_PROMPT;
    setAppLanguage(sanitized.language);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(mt('水印清理工作台', 'Watermark Lab'));
  }
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  const temporary = uniqueTemporaryPath(settingsPath());
  await fs.writeFile(temporary, JSON.stringify(sanitized, null, 2), 'utf8');
  await fs.rename(temporary, settingsPath());
  return sanitized;
}

// Dock（macOS）与窗口/任务栏（Windows）图标随主题色变化：
// 只旋转图标中绿色系像素的色相，白色/金色条纹与渐变质感保持不变；按色相缓存避免重复计算
let baseIconCache = null;
let themedIcon = null;
let appliedIconHue = null;
function updateThemedIcon(themeColor) {
  const targetHue = hueOfColor(themeColor);
  if (targetHue === null) return;
  if (targetHue !== appliedIconHue) {
    if (!baseIconCache) {
      const image = nativeImage.createFromPath(APP_ICON_PATH);
      if (image.isEmpty()) return;
      const resized = image.resize({ width: 512, height: 512, quality: 'good' });
      const { width, height } = resized.getSize();
      baseIconCache = { pixels: resized.toBitmap(), width, height };
    }
    const tinted = retintPixels(baseIconCache.pixels, targetHue);
    themedIcon = nativeImage.createFromBitmap(tinted, { width: baseIconCache.width, height: baseIconCache.height });
    appliedIconHue = targetHue;
  }
  if (!themedIcon || themedIcon.isEmpty()) return;
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(themedIcon);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(themedIcon);
}

// Windows 无边框的系统按钮随主题着色：背景≈顶栏色、符号≈正文色；auto 模式下跟随系统深浅色切换
let lastAppliedSettings = null;
function titleBarOverlayColors(settings) {
  const dark = settings.themeMode === 'dark'
    || (settings.themeMode !== 'light' && nativeTheme.shouldUseDarkColors);
  const hex = /^#[0-9a-f]{6}$/i.test(settings.themeColor || '') ? settings.themeColor : PALETTE_COLORS.forest;
  const rgb = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  const base = dark ? [16, 23, 20] : [238, 243, 240];
  const ratio = dark ? 0.16 : 0.07;
  const color = `#${[0, 1, 2]
    .map((i) => Math.round(base[i] * (1 - ratio) + rgb[i] * ratio).toString(16).padStart(2, '0'))
    .join('')}`;
  return { color, symbolColor: dark ? '#e8efeb' : '#33423b' };
}

// 外观变化的副作用统一入口：主题图标 + Windows 标题栏按钮配色
function applyAppearanceSideEffects(settings) {
  lastAppliedSettings = settings;
  updateThemedIcon(settings.themeColor);
  if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitleBarOverlay({ ...titleBarOverlayColors(settings), height: 40 });
  }
}

function sanitizeQueueRecord(record = {}) {
  const sourcePath = typeof record.path === 'string' && path.isAbsolute(record.path)
    ? path.resolve(record.path)
    : '';
  if (!sourcePath) return null;
  const outputPath = typeof record.outputPath === 'string' && path.isAbsolute(record.outputPath)
    ? path.resolve(record.outputPath)
    : '';
  const thumbnail = typeof record.thumbnail === 'string'
    && record.thumbnail.length <= 600_000
    && /^data:image\//i.test(record.thumbnail)
    ? record.thumbnail
    : '';
  return {
    path: sourcePath,
    name: typeof record.name === 'string' ? record.name.slice(0, 240) : path.basename(sourcePath),
    bytes: Math.max(0, Number(record.bytes) || 0),
    width: Math.max(0, Number(record.width) || 0),
    height: Math.max(0, Number(record.height) || 0),
    thumbnail,
    status: ['complete', 'error'].includes(record.status) ? record.status : '',
    message: typeof record.message === 'string' ? record.message.slice(0, 500) : '',
    ...(typeof record.selected === 'boolean' ? { selected: record.selected } : {}),
    conversationId: typeof record.conversationId === 'string' && /^[0-9a-zA-Z_-]{6,64}$/.test(record.conversationId)
      ? record.conversationId
      : '',
    outputPath,
    outputWidth: Math.max(0, Number(record.outputWidth) || 0),
    outputHeight: Math.max(0, Number(record.outputHeight) || 0),
    cropped: Boolean(record.cropped),
    cropPercent: Math.max(0, Number(record.cropPercent) || 0),
    cropEdge: record.cropEdge === 'bottom' ? 'bottom' : 'top',
    removedUploadPadding: Boolean(record.removedUploadPadding),
    autoRepairPasses: Math.min(2, Math.max(0, Math.round(Number(record.autoRepairPasses) || 0))),
    residualAuditCount: Math.min(3, Math.max(0, Math.round(Number(record.residualAuditCount) || 0))),
    residualStatus: [
      'manual-skip', 'checking', 'clean', 'repaired-clean', 'review',
      'residual-after-max', 'audit-failed', 'repair-failed', 'repaired-pending-audit'
    ].includes(record.residualStatus) ? record.residualStatus : '',
    overwroteOriginal: record.overwroteOriginal === true,
    overwriteStatus: [
      'disabled', 'overwritten', 'manual-skip', 'blocked-residual', 'blocked-qc',
      'unsupported-format', 'failed'
    ].includes(record.overwriteStatus) ? record.overwriteStatus : '',
    // 采集来源随队列持久化，重启后「直取原图/降级裁切/页面采集」徽标仍在
    captureSource: ['api-raw', 'network', 'dom', 'canvas', 'canvas-screenshot', 'editor-download'].includes(record.captureSource)
      ? record.captureSource
      : '',
    // 质检结论随队列持久化，重启后黄标仍在
    ...(record.qc && typeof record.qc === 'object' ? {
      qc: {
        verdict: ['ok', 'unchanged', 'different'].includes(record.qc.verdict) ? record.qc.verdict : 'ok',
        changedRatio: Math.min(1, Math.max(0, Number(record.qc.changedRatio) || 0)),
        meanDiff: Math.min(255, Math.max(0, Number(record.qc.meanDiff) || 0))
      }
    } : {})
  };
}

async function saveQueueRecords(records) {
  const sanitized = (Array.isArray(records) ? records : [])
    .slice(0, 300)
    .map(sanitizeQueueRecord)
    .filter(Boolean);
  await fs.mkdir(path.dirname(queueRecordsPath()), { recursive: true });
  const temporary = uniqueTemporaryPath(queueRecordsPath());
  await fs.writeFile(temporary, JSON.stringify(sanitized, null, 2), 'utf8');
  await fs.rename(temporary, queueRecordsPath());
  return true;
}

async function validStoredOutput(targetPath) {
  if (!targetPath || !SUPPORTED_EXTENSIONS.has(path.extname(targetPath).toLowerCase())) return '';
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile() && stat.size <= 80 * 1024 * 1024 ? targetPath : '';
  } catch {
    return '';
  }
}

async function loadQueueRecords() {
  let saved;
  try {
    saved = JSON.parse(await fs.readFile(queueRecordsPath(), 'utf8'));
  } catch {
    return [];
  }
  const records = [];
  for (const rawRecord of (Array.isArray(saved) ? saved : []).slice(0, 300)) {
    const record = sanitizeQueueRecord(rawRecord);
    if (!record) continue;
    const [freshSource] = await validateImagePaths([record.path]);
    const outputPath = await validStoredOutput(record.outputPath);
    const source = freshSource || {
      path: record.path,
      name: record.name,
      bytes: record.bytes,
      width: record.width,
      height: record.height,
      thumbnail: record.thumbnail,
      missing: true
    };
    records.push({
      ...record,
      ...source,
      outputPath,
      status: outputPath ? 'complete' : (source.missing ? 'error' : (record.status === 'error' ? 'error' : '')),
      message: outputPath ? '' : (source.missing ? '原图文件已移动或删除' : record.message)
    });
  }
  return records;
}

// Windows 上毛玻璃（backdrop-filter）合成层会让 Chromium 关闭次像素抗锯齿，
// 中文渲染发虚。给本地窗口 body 打上平台标记，样式表据此关闭背景模糊、提高面板不透明度。
// 只用于本地页面，绝不注入豆包等外部页面。
function applyPlatformWindowTweaks(window) {
  if (process.platform !== 'win32') return;
  window.webContents.on('dom-ready', () => {
    window.webContents.executeJavaScript(
      `document.body && document.body.classList.add('platform-win32')`
    ).catch(() => {});
  });
}

function createMainWindow() {
  // 默认尺寸即最小尺寸：保证右侧设置区在中英文下都完整放下、永不出现滚动
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 792,
    minWidth: 1160,
    minHeight: 792,
    backgroundColor: '#f5f4ef',
    icon: APP_ICON_PATH,
    // Windows 无边框：隐藏系统标题栏，用 titleBarOverlay 保留原生最小化/最大化/关闭（含 Win11 贴靠布局）；
    // 鸿蒙无边框窗口没有三键（无法关闭/最小化），必须用系统默认边框
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : (IS_OHOS ? 'default' : 'hidden'),
    ...(process.platform === 'win32' ? { titleBarOverlay: { color: '#eef3f0', symbolColor: '#33423b', height: 40 } } : {}),
    title: mt('水印清理工作台', 'Watermark Lab'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  applyPlatformWindowTweaks(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
    // 主窗口关闭即退出整个应用：强制销毁豆包等后台窗口，避免进程残留
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.destroy();
    }
    app.quit();
  });
}

function configureDoubaoSession() {
  const persistentSession = session.fromPartition(DOUBAO_PARTITION);
  persistentSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  persistentSession.setPermissionCheckHandler((_webContents, permission) => permission === 'clipboard-sanitized-write');
  return persistentSession;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function cookieLoginHint() {
  try {
    const cookies = await session.fromPartition(DOUBAO_PARTITION).cookies.get({ url: 'https://www.doubao.com/' });
    return cookies.some((cookie) => !/csrf/i.test(cookie.name)
      && /^(?:sessionid(?:_ss)?|sid_(?:guard|tt)|uid_tt(?:_ss)?|passport_auth_status|sso_auth_status)$/i.test(cookie.name));
  } catch {
    return false;
  }
}

async function getLoginStatus() {
  const cookieHint = await cookieLoginHint();
  let pageStatus = null;
  if (doubaoWindow && !doubaoWindow.isDestroyed() && !doubaoWindow.webContents.isLoading()) {
    try {
      const automation = new DoubaoAutomation(doubaoWindow);
      pageStatus = await automation.getLoginStatus();
    } catch {
      pageStatus = null;
    }
  }
  // 页面已确认可聊天/可上传时直接相信页面能力信号，不再要求头像必须存在；
  // 没有可探测页面时沿用持久 Cookie 作为“可尝试自动恢复”的登录提示。
  const loggedIn = pageStatus ? pageStatus.loggedIn === true : cookieHint;
  return {
    loggedIn,
    state: pageStatus?.state || (cookieHint ? 'authenticated' : 'uncertain'),
    cookieHint: pageStatus?.cookieHint ?? cookieHint,
    pageStatus,
    persistent: true
  };
}

function loginRecoveryCancelledError() {
  const error = new Error('批处理已取消');
  error.code = 'CANCELLED';
  return error;
}

async function waitForSharedLoginRecovery(promise, cancelRef) {
  while (true) {
    if (cancelRef?.value) throw loginRecoveryCancelledError();
    const outcome = await Promise.race([
      promise.then((value) => ({ done: true, value }), (error) => ({ done: true, error })),
      new Promise((resolve) => setTimeout(() => resolve({ done: false }), 450))
    ]);
    if (!outcome.done) continue;
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }
}

async function loadDoubaoChatForRecovery(workerWindow) {
  if (!workerWindow || workerWindow.isDestroyed()) {
    const error = new Error('豆包工作窗口已关闭，无法自动恢复登录');
    error.code = 'LOGIN_RECOVERY_FAILED';
    throw error;
  }
  await Promise.race([
    workerWindow.loadURL(DOUBAO_CHAT_URL),
    new Promise((_, reject) => setTimeout(() => reject(new Error('豆包会话恢复加载超时')), 25_000))
  ]).catch((error) => {
    if (/ERR_ABORTED/i.test(String(error?.message || ''))) return;
    throw error;
  });
  await waitForDoubaoLoad(workerWindow).catch(() => {});
}

async function recoverDoubaoLogin(workerWindow, {
  cancelRef,
  jobBase,
  keepVisible = false
} = {}) {
  const progress = (message) => {
    if (jobBase) batchEvent({ type: 'job-progress', ...jobBase, message });
    if (workerWindow && !workerWindow.isDestroyed()) {
      workerWindow.setTitle(`${rendererI18n.t(message)} · ${mt('水印清理工作台', 'Watermark Lab')}`);
    }
  };

  if (loginRecoveryGate.promise) {
    progress('另一个任务正在恢复豆包登录，本任务已暂停等待');
    try {
      const result = await waitForSharedLoginRecovery(loginRecoveryGate.promise, cancelRef);
      if (workerWindow && !workerWindow.isDestroyed()) {
        await loadDoubaoChatForRecovery(workerWindow).catch(() => {});
      }
      return result;
    } catch (error) {
      // 若领头任务恰好被用户单独取消，其他仍在运行的批次不能跟着被取消；
      // 等共享恢复槽释放后，由本任务接棒重新执行恢复。
      if (error?.code === 'CANCELLED' && !cancelRef?.value) {
        while (loginRecoveryGate.promise) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return recoverDoubaoLogin(workerWindow, { cancelRef, jobBase, keepVisible });
      }
      throw error;
    }
  }

  const token = { startedAt: Date.now() };
  loginRecoveryGate.owner = token;
  const recoveryPromise = (async () => {
    progress('登录状态异常，正在自动恢复…');
    const automation = () => new DoubaoAutomation(workerWindow, {
      isCancelled: () => Boolean(cancelRef?.value),
      onProgress: progress
    });

    // 1) 原地多次复查，先过滤头像/DOM 暂时没渲染造成的假退出。
    let status = await automation().confirmLoginStatus({ attempts: 3 });
    if (status.state === 'authenticated') {
      progress('豆包登录状态正常，正在重新开始任务');
      return { recovered: true, stage: 'recheck' };
    }

    // 2) 刷回聊天首页，仍保留 persist session 中所有 Cookie / localStorage。
    progress('正在刷新豆包会话…');
    await loadDoubaoChatForRecovery(workerWindow);
    status = await automation().confirmLoginStatus({ attempts: 3 });
    if (status.state === 'authenticated') {
      progress('豆包会话已自动恢复，正在重新开始任务');
      return { recovered: true, stage: 'reload' };
    }

    // 3) 软重置当前工作窗口。只重建页面上下文，不清 Cookie、不清缓存、不清登录数据。
    progress('正在重置豆包工作窗口…');
    try {
      await workerWindow.loadURL('about:blank');
      await new Promise((resolve) => setTimeout(resolve, 350));
    } catch { /* 继续加载聊天首页 */ }
    await loadDoubaoChatForRecovery(workerWindow);
    status = await automation().confirmLoginStatus({ attempts: 3 });
    if (status.state === 'authenticated') {
      progress('豆包工作窗口已恢复，正在重新开始任务');
      return { recovered: true, stage: 'window-reset' };
    }

    // 4) 确认真正需要登录：自动显示唯一一个登录窗口并发起登录。
    // 若豆包能通过已有 SSO/Cookie 自动恢复会直接通过；只有短信/扫码等才需要用户操作。
    progress('豆包需要重新登录，任务已暂停；登录成功后会自动继续');
    loginFlowActive = true;
    if (workerWindow.isMinimized()) workerWindow.restore();
    workerWindow.show();
    workerWindow.moveTop();
    workerWindow.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });

    const loginAutomation = automation();
    await loginAutomation.openLoginDialog().catch(() => {});

    const started = Date.now();
    const maxWaitMs = 10 * 60_000;
    while (Date.now() - started < maxWaitMs) {
      if (cancelRef?.value) throw loginRecoveryCancelledError();
      const current = await loginAutomation.getLoginStatus().catch(() => null);
      if (current?.state === 'authenticated') {
        loginFlowActive = false;
        try { workerWindow.webContents.session.flushStorageData(); } catch { /* 持久化失败不阻塞恢复 */ }
        if (!keepVisible && !workerWindow.isDestroyed()) workerWindow.hide();
        progress('登录会话已恢复，正在重新开始任务');
        return { recovered: true, stage: 'interactive-login' };
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    const timeoutError = new Error('等待豆包重新登录超时；当前任务未丢失，可完成登录后重新开始');
    timeoutError.code = 'LOGIN_RECOVERY_TIMEOUT';
    throw timeoutError;
  })();

  loginRecoveryGate.promise = recoveryPromise;
  let recoverySucceeded = false;
  try {
    const result = await recoveryPromise;
    recoverySucceeded = true;
    // 仅仅“重新复查后发现原本就已登录”不广播全局重启，避免一个窗口的假阴性打断其他正常任务。
    if (result?.stage !== 'recheck') loginRecoveryEpoch.value += 1;
    try {
      if (doubaoWindow && !doubaoWindow.isDestroyed()
        && doubaoWindow !== workerWindow && !busyWindows.has(doubaoWindow)) {
        await loadDoubaoChatForRecovery(doubaoWindow);
      }
    } catch { /* 主登录窗口刷新失败不影响已恢复的工作窗口 */ }
    // 恢复窗口已经实测可聊天，直接同步顶部状态；避免另一个尚未重载的旧窗口 DOM 短暂把状态打回“未登录”。
    sendToRenderer('login:status', {
      loggedIn: true,
      state: 'authenticated',
      cookieHint: true,
      pageStatus: null,
      persistent: true
    });
    return result;
  } finally {
    if (loginRecoveryGate.owner === token) {
      if (!recoverySucceeded) loginFlowActive = false;
      loginRecoveryGate.owner = null;
      loginRecoveryGate.promise = null;
    }
  }
}

function safeWebContents(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed?.()) return null;
  try {
    const contents = browserWindow.webContents;
    return contents && !contents.isDestroyed?.() ? contents : null;
  } catch {
    return null;
  }
}

function isDoubaoWorkerUsable(browserWindow) {
  const contents = safeWebContents(browserWindow);
  return Boolean(contents && !browserWindow.__workerDead && !browserWindow.__workerUnresponsive);
}

function windowUsesDoubaoSession(browserWindow, persistentSession) {
  const contents = safeWebContents(browserWindow);
  if (!contents) return false;
  try {
    return contents.session === persistentSession;
  } catch {
    return false;
  }
}

function bindDoubaoWorkerHealth(browserWindow) {
  if (!browserWindow || browserWindow.__workerHealthBound) return browserWindow;
  browserWindow.__workerHealthBound = true;
  browserWindow.__workerDead = false;
  browserWindow.__workerUnresponsive = false;
  browserWindow.__workerFailureReason = '';

  const contents = safeWebContents(browserWindow);
  if (contents) {
    contents.on('render-process-gone', (_event, details = {}) => {
      browserWindow.__workerDead = true;
      browserWindow.__workerFailureReason = `render-process-gone:${details.reason || 'unknown'}`;
    });
    contents.on('destroyed', () => {
      browserWindow.__workerDead = true;
      browserWindow.__workerFailureReason = 'webContents-destroyed';
    });
  }
  browserWindow.on('unresponsive', () => {
    browserWindow.__workerUnresponsive = true;
    browserWindow.__workerFailureReason = 'unresponsive';
  });
  browserWindow.on('responsive', () => {
    if (!browserWindow.__workerDead) {
      browserWindow.__workerUnresponsive = false;
      browserWindow.__workerFailureReason = '';
    }
  });
  return browserWindow;
}

function discardDoubaoWorker(browserWindow) {
  if (!browserWindow) return;
  busyWindows.delete(browserWindow);
  auxWorkerWindows = auxWorkerWindows.filter((item) => item !== browserWindow);
  if (doubaoWindow === browserWindow) doubaoWindow = null;
  try {
    if (!browserWindow.isDestroyed?.()) browserWindow.destroy();
  } catch { /* 已损坏的 Electron 对象无需再次处理 */ }
}

async function broadcastLoginStatus() {
  const status = await getLoginStatus();
  sendToRenderer('login:status', status);
  if (loginFlowActive && status.loggedIn) {
    loginFlowActive = false;
    const persistentSession = session.fromPartition(DOUBAO_PARTITION);
    try { persistentSession.flushStorageData(); } catch { /* 忽略持久化瞬时错误 */ }
    clearInterval(loginTimer);
    loginTimer = null;
    // 批处理运行期间绝不销毁任何豆包窗口。旧逻辑虽然跳过 busy 窗口，
    // 但窗口池/登录恢复切换存在极短竞态，可能把仍被异步链持有的 webContents 销毁，
    // 最终冒出 "Object has been destroyed"。运行中只隐藏空闲窗口，批次结束后再复用/回收。
    for (const window of BrowserWindow.getAllWindows()) {
      if (window === mainWindow || !windowUsesDoubaoSession(window, persistentSession) || busyWindows.has(window)) continue;
      try {
        window.hide();
        if (activeBatchCount <= 0 && isDoubaoWorkerUsable(window)) window.destroy();
      } catch { /* 窗口已损坏时由健康检查/重建链处理 */ }
    }
    if (!isDoubaoWorkerUsable(doubaoWindow)) doubaoWindow = null;
  }
}

async function waitForDoubaoLoad(browser) {
  if (!isDoubaoWorkerUsable(browser)) throw workerDestroyedError();
  const contents = safeWebContents(browser);
  if (!contents) throw workerDestroyedError();
  if (!contents.isLoading()) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      try { contents.removeListener('did-finish-load', onFinish); } catch {}
      try { contents.removeListener('did-fail-load', onFail); } catch {}
      try { contents.removeListener('destroyed', onDestroyed); } catch {}
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onDestroyed = () => {
      cleanup();
      reject(workerDestroyedError());
    };
    // 加载失败（断网、DNS 失败等）立即报错，不再干等超时；子资源失败（isMainFrame=false）忽略
    const onFail = (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      cleanup();
      reject(new Error(`豆包页面加载失败（${errorDescription || errorCode}），请检查网络后重试`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('豆包页面加载超时'));
    }, 35_000);
    contents.on('did-finish-load', onFinish);
    contents.on('did-fail-load', onFail);
    contents.once('destroyed', onDestroyed);
  });
}

async function openDoubaoLogin() {
  const currentStatus = await getLoginStatus();
  loginFlowActive = !currentStatus.loggedIn;
  const browser = createDoubaoWindow({ focus: true });
  await waitForDoubaoLoad(browser);
  browser.show();
  browser.focus();
  const automation = new DoubaoAutomation(browser);
  const result = await automation.openLoginDialog();
  if (result.alreadyLoggedIn) loginFlowActive = false;
  await broadcastLoginStatus();
  return result;
}

async function logoutDoubao() {
  if (activeBatchCount > 0) throw new Error('批处理运行期间不能退出登录');
  clearInterval(loginTimer);
  loginTimer = null;
  loginFlowActive = false;

  const persistentSession = session.fromPartition(DOUBAO_PARTITION);
  for (const window of BrowserWindow.getAllWindows()) {
    if (window !== mainWindow && windowUsesDoubaoSession(window, persistentSession)) {
      try { window.destroy(); } catch {}
    }
  }
  doubaoWindow = null;
  await persistentSession.clearStorageData();
  await persistentSession.clearCache();
  await persistentSession.clearAuthCache();
  persistentSession.flushStorageData();
  sendToRenderer('login:status', {
    loggedIn: false,
    cookieHint: false,
    pageStatus: null,
    persistent: true
  });
  return true;
}

function createDoubaoWindow({ focus = true } = {}) {
  if (doubaoWindow && isDoubaoWorkerUsable(doubaoWindow)) {
    if (focus) doubaoWindow.show();
    return doubaoWindow;
  }
  if (doubaoWindow) discardDoubaoWorker(doubaoWindow);

  configureDoubaoSession();
  doubaoWindow = bindDoubaoWorkerHealth(new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 780,
    minHeight: 620,
    show: focus,
    title: mt('豆包网页 · 水印清理工作台', 'Doubao Web · Watermark Lab'),
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: DOUBAO_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      safeDialogs: true
    }
  }));

  doubaoWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/([\w-]+\.)*(doubao\.com|bytedance\.com|toutiao\.com|feishu\.cn)\//i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: doubaoWindow,
          autoHideMenuBar: true,
          webPreferences: {
            partition: DOUBAO_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const update = () => setTimeout(broadcastLoginStatus, 800);
  doubaoWindow.webContents.on('did-finish-load', update);
  doubaoWindow.webContents.on('did-navigate', update);
  doubaoWindow.webContents.on('did-navigate-in-page', update);
  doubaoWindow.loadURL(DOUBAO_CHAT_URL);
  const createdDoubaoWindow = doubaoWindow;
  createdDoubaoWindow.on('closed', () => {
    if (doubaoWindow === createdDoubaoWindow) doubaoWindow = null;
    if (activeBatchCount <= 0) {
      loginFlowActive = false;
      clearInterval(loginTimer);
      loginTimer = null;
    }
    broadcastLoginStatus().catch(() => {});
  });
  loginTimer = setInterval(broadcastLoginStatus, 5000);
  return doubaoWindow;
}

let auxWorkerWindows = [];

function createAuxWorkerWindow(position) {
  const workerWindow = bindDoubaoWorkerHealth(new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 780,
    minHeight: 620,
    show: false,
    title: mt(`豆包网页 · 并行任务 ${position + 2}`, `Doubao Web · Worker ${position + 2}`),
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: DOUBAO_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      safeDialogs: true
    }
  }));

  workerWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/([\w-]+\.)*(doubao\.com|bytedance\.com|toutiao\.com|feishu\.cn)\//i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: workerWindow,
          autoHideMenuBar: true,
          webPreferences: {
            partition: DOUBAO_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  workerWindow.on('closed', () => {
    auxWorkerWindows = auxWorkerWindows.filter((item) => item !== workerWindow);
  });
  workerWindow.loadURL(DOUBAO_CHAT_URL);
  return workerWindow;
}

function hideIdleDoubaoWindows() {
  const persistentSession = session.fromPartition(DOUBAO_PARTITION);
  for (const window of BrowserWindow.getAllWindows()) {
    if (window !== mainWindow && windowUsesDoubaoSession(window, persistentSession) && !busyWindows.has(window)) {
      try { window.hide(); } catch {}
    }
  }
}

// 为批次分配互不冲突的豆包窗口：优先复用空闲窗口，不够时新建；批次结束后释放
async function acquireBatchWindows(count, { show }) {
  createDoubaoWindow({ focus: false });
  const idleWindows = () => [doubaoWindow, ...auxWorkerWindows]
    .filter((window) => isDoubaoWorkerUsable(window) && !busyWindows.has(window));
  const windows = [];
  for (let index = 0; index < count; index += 1) {
    let window = idleWindows().find((item) => !windows.includes(item));
    if (!window) {
      window = createAuxWorkerWindow(auxWorkerWindows.length);
      auxWorkerWindows.push(window);
    }
    busyWindows.add(window);
    // 记录原始标题，任务期间的进度标题在批次结束后还原
    if (!window.__baseTitle) window.__baseTitle = window.getTitle();
    windows.push(window);
  }
  if (show) {
    windows.forEach((window, index) => {
      window.setPosition(90 + index * 56, 70 + index * 48);
      window.show();
    });
    if (activeBatchCount <= 1) windows[0].focus();
  } else {
    hideIdleDoubaoWindows();
  }
  try {
    await Promise.all(windows.map(waitForDoubaoLoad));
  } catch (error) {
    windows.forEach((window) => busyWindows.delete(window));
    throw error;
  }
  return windows;
}

async function validateImagePaths(paths) {
  const unique = [...new Set((paths || []).filter((value) => typeof value === 'string').map((value) => path.resolve(value)))];
  const valid = [];
  for (const filePath of unique.slice(0, 300)) {
    if (!SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size > 80 * 1024 * 1024) continue;
      const previewImage = nativeImage.createFromPath(filePath);
      if (previewImage.isEmpty()) continue;
      const preview = previewImage.resize({ width: 104, height: 104, quality: 'good' });
      const size = previewImage.getSize();
      valid.push({
        path: filePath,
        name: path.basename(filePath),
        bytes: stat.size,
        width: size.width,
        height: size.height,
        thumbnail: preview.toDataURL()
      });
    } catch {
      // Ignore unreadable dropped files.
    }
  }
  return valid;
}

function batchEvent(payload) {
  sendToRenderer('batch:event', payload);
}

async function runBatch(items, rawSettings, runtime = {}) {
  const mode = runtime.mode === 'manual' ? 'manual' : 'batch';
  // 批处理与涂抹重绘都允许并发，合计上限由「同时处理」设置决定（默认 3，控制风控）
  const maxConcurrent = sanitizeSettings(rawSettings || {}).maxConcurrentTasks || PARALLEL_WORKER_COUNT;
  if (activeBatchCount >= maxConcurrent) {
    throw new Error(`最多同时处理 ${maxConcurrent} 张图片，请等待其中一张完成`);
  }
  // 守卫通过后同步占位：快速连续点击也不会突破并发上限
  const batchId = `batch-${Date.now()}-${batchSeq += 1}`;
  const cancelRef = { value: false };
  activeCancelRefs.add(cancelRef);
  activeBatchCount += 1;
  try {
    return await runBatchReserved(items, rawSettings, runtime, { mode, batchId, cancelRef });
  } finally {
    activeCancelRefs.delete(cancelRef);
    activeBatchCount -= 1;
  }
}

async function runBatchReserved(items, rawSettings, runtime, { mode, batchId, cancelRef }) {
  // 渲染进程会把每个任务的历史会话一起带过来（{ path, conversationId }），校验后合并回文件对象
  const requestedConversations = new Map();
  const requestedPaths = (Array.isArray(items) ? items : []).map((item) => {
    if (typeof item === 'string') return item;
    const itemPath = typeof item?.path === 'string' ? path.resolve(item.path) : '';
    const conversationId = typeof item?.conversationId === 'string' && /^[0-9a-zA-Z_-]{6,64}$/.test(item.conversationId)
      ? item.conversationId
      : '';
    if (itemPath && conversationId) requestedConversations.set(itemPath, conversationId);
    return itemPath;
  }).filter(Boolean);
  const files = Array.isArray(runtime.files)
    ? runtime.files
    : (await validateImagePaths(requestedPaths)).map((file) => ({
      ...file,
      conversationId: requestedConversations.get(file.path) || file.conversationId || ''
    }));
  if (!files.length) throw new Error('请先选择要处理的图片');
  const settings = runtime.persistSettings === false
    ? sanitizeSettings(rawSettings)
    : await saveSettings(rawSettings);
  const useParallel = mode !== 'manual' && settings.parallelProcessing && files.length > 1;
  const windows = await acquireBatchWindows(useParallel ? Math.min(settings.maxConcurrentTasks || PARALLEL_WORKER_COUNT, files.length) : 1, {
    show: settings.showBrowserWindow
  });
  const browser = windows[0];
  const releaseWindows = () => windows.forEach((window) => {
    busyWindows.delete(window);
    // 还原任务期间显示进度的窗口标题
    if (!window.isDestroyed() && window.__baseTitle) window.setTitle(window.__baseTitle);
  });

  batchEvent({
    type: 'batch-start',
    batchId,
    total: files.length,
    mode,
    path: runtime.eventPath || null,
    parallel: useParallel,
    workers: useParallel ? windows.length : 1
  });
  const results = [];

  const processAttempt = async (index, workerWindow, epochRef) => {
    const file = files[index];
    const eventPath = files.length === 1 && runtime.eventPath ? runtime.eventPath : file.path;
    const sourcePath = files.length === 1 && runtime.sourcePath ? runtime.sourcePath : file.path;
    const jobBase = {
      index,
      batchId,
      path: eventPath,
      name: path.basename(sourcePath),
      total: files.length,
      mode
    };
    batchEvent({ type: 'job-start', ...jobBase });

    // 本次尝试的验证领头令牌：占住 verificationGate 期间只有本任务弹出验证窗口
    const verificationToken = { batchId, index };
    const automation = new DoubaoAutomation(workerWindow, {
      isCancelled: () => cancelRef.value,
      // 信号值大于本任务基线，说明有任务完成了安全验证：本任务也可能已被波及，整任务重启
      shouldRestart: () => {
        if (loginRecoveryEpoch.value > epochRef.login) return 'login';
        return verificationEpoch.value > epochRef.verification;
      },
      // 进度同时打到豆包窗口标题：开着调试窗口时能直接看到当前进行到哪一步，不再像卡住
      onProgress: (message) => {
        batchEvent({ type: 'job-progress', ...jobBase, message });
        if (workerWindow && !workerWindow.isDestroyed()) {
          workerWindow.setTitle(`${rendererI18n.t(message)} · ${mt('水印清理工作台', 'Watermark Lab')}`);
        }
      },
      // 返回 false = 已有其他窗口在验证（本任务是跟随者）：不弹窗，静默等待领头完成后自动重跑。
      // 验证是会话级风控，做完一次全会话生效，只需要让用户做一次
      onVerificationRequired: () => {
        if (verificationGate.owner && verificationGate.owner !== verificationToken) return false;
        verificationGate.owner = verificationToken;
        const focusTarget = (workerWindow && !workerWindow.isDestroyed() && workerWindow) || browser;
        if (focusTarget && !focusTarget.isDestroyed()) {
          if (focusTarget.isMinimized()) focusTarget.restore();
          focusTarget.show();
          focusTarget.moveTop();
          focusTarget.focus();
        }
        if (process.platform === 'darwin') app.focus({ steal: true });
        batchEvent({ type: 'verification-required', ...jobBase });
        return true;
      },
      onVerificationCleared: async () => {
        // 只有领头任务的验证完成才广播重启信号；跟随者的页面偶发自行恢复时只重跑自己
        if (verificationGate.owner !== verificationToken) return;
        verificationGate.owner = null;
        verificationEpoch.value += 1;
        batchEvent({ type: 'verification-cleared', ...jobBase });
        if (!settings.showBrowserWindow) {
          if (workerWindow && !workerWindow.isDestroyed()) workerWindow.hide();
          hideIdleDoubaoWindows();
        }
      }
    });

    let taskConversationId = typeof file.conversationId === 'string' ? file.conversationId : '';
    // 同一会话不能被两个任务同时使用（无论并行任务还是并发批次），后来的任务另起新会话
    if (taskConversationId && inUseConversations.has(taskConversationId)) taskConversationId = '';
    if (taskConversationId) inUseConversations.add(taskConversationId);
    let paddedUpload = null;
    try {
      const promptText = runtime.prompt || buildPrompt(settings);
      // 第一轮：原图直发（不加隔离带、不做任何加工），尝试从接口拦截无水印原图；
      // 命中即不裁切直接导出
      const firstPass = await automation.processImage({
        filePath: file.path,
        prompt: promptText,
        // 每个任务独占一个会话：有历史会话先接回（接回失败 processImage 内会自动开新对话），
        // 没有历史会话的一律开新对话，避免多张图串进同一会话、记录的会话 ID 互相覆盖
        newConversation: true,
        conversationId: taskConversationId,
        imageWaitSeconds: settings.imageWaitSeconds
      });
      let candidates = firstPass.candidates;
      let conversationId = firstPass.conversationId;
      let uploadPath = file.path;
      // 降级：接口没拦截到无水印原图时，加临时隔离带在同会话重发一次，回到白边裁切管线。
      // （第一轮无隔离带，生成图的 AI 标识落在画面内无法干净裁除，所以必须带隔离带重发；
      //   用户主动关闭隔离带/裁切设置时则跳过重发，直接沿用第一轮候选）
      if (!firstPass.apiRawHit && settings.addPaddingBeforeUpload && settings.cropMode !== 'never') {
        const edgeName = settings.cropEdge === 'bottom' ? '底部' : '顶部';
        batchEvent({
          type: 'job-progress',
          ...jobBase,
          message: `未能拦截到无水印原图，改用隔离带方案：给原图${edgeName}添加 ${settings.cropPercent}% 临时空白带后重发`
        });
        paddedUpload = await preparePaddedUpload({
          sourcePath: file.path,
          nativeImage,
          temporaryDirectory: app.getPath('temp'),
          percent: settings.cropPercent,
          edge: settings.cropEdge
        });
        uploadPath = paddedUpload.path;
        const secondPass = await automation.processImage({
          filePath: uploadPath,
          prompt: promptText,
          newConversation: true,
          conversationId: conversationId || taskConversationId,
          imageWaitSeconds: settings.imageWaitSeconds
        });
        candidates = secondPass.candidates;
        conversationId = secondPass.conversationId || conversationId;
      }
      let candidate;
      try {
        candidate = await downloadBestImage({
          candidates,
          electronSession: workerWindow.webContents.session,
          nativeImage,
          preferOriginal: settings.preferOriginal,
          onProgress: (message) => {
            batchEvent({ type: 'job-progress', ...jobBase, message });
            if (workerWindow && !workerWindow.isDestroyed()) {
              workerWindow.setTitle(`${rendererI18n.t(message)} · ${mt('水印清理工作台', 'Watermark Lab')}`);
            }
          }
        });
      } catch (downloadError) {
        batchEvent({
          type: 'job-progress',
          ...jobBase,
          message: '大图链接不可直接下载，切换到高清画布导出'
        });
        try {
          candidate = await automation.captureLatestGeneratedCanvas(nativeImage, candidates);
        } catch (canvasError) {
          throw new Error(`${downloadError.message}；高清画布兜底也失败：${canvasError.message}`);
        }
      }
      const matchesUploadedImage = !String(candidate.source || '').startsWith('canvas')
        && (await isExactSourceImage(candidate, uploadPath)
          || (uploadPath !== file.path && await isExactSourceImage(candidate, file.path))
          || (sourcePath !== file.path && await isExactSourceImage(candidate, sourcePath)));
      if (matchesUploadedImage) {
        batchEvent({
          type: 'job-progress',
          ...jobBase,
          message: '候选资源与上传图片完全相同，已作废并切换到生成结果画布'
        });
        try {
          candidate = await automation.captureLatestGeneratedCanvas(nativeImage, candidates);
        } catch (canvasError) {
          throw new Error(`豆包返回了上传原图而不是生成结果；生成结果画布导出也失败：${canvasError.message}`);
        }
      }
      let saved = await saveProcessedImage({
        candidate,
        sourcePath,
        outputDirectory: settings.outputDirectory,
        settings,
        paddedUpload
      });

      // 通用残留水印闭环：不依赖固定位置、颜色、语言或某一种 Logo。
      // 先让视觉模型全图复检并返回归一化区域；只对高置信区域自动打粉色遮罩做定点补修，
      // 每次补修后再次复检，最多 2 轮。复检/补修失败时保留上一张有效结果，不把整单打失败。
      let autoRepairPasses = 0;
      let residualAuditCount = 0;
      let residualStatus = mode === 'manual' ? 'manual-skip' : 'checking';
      if (mode !== 'manual') {
        const maxAutoRepairPasses = 2;
        for (let auditIndex = 0; auditIndex <= maxAutoRepairPasses; auditIndex += 1) {
          let audit;
          try {
            residualAuditCount += 1;
            batchEvent({
              type: 'job-progress',
              ...jobBase,
              message: `正在全图复检残留水印（${residualAuditCount}/${maxAutoRepairPasses + 1}）`
            });
            audit = await automation.inspectWatermarkResidual({
              filePath: saved.path,
              prompt: buildWatermarkAuditPrompt(settings),
              timeoutMs: 90_000
            });
          } catch (auditError) {
            if (['CANCELLED', 'VERIFICATION_INTERRUPTED', 'LOGIN_RECOVERED_RESTART', 'LOGIN_RECOVERY_REQUIRED'].includes(auditError.code)) {
              await fs.rm(saved.path, { force: true }).catch(() => {});
              throw auditError;
            }
            residualStatus = 'audit-failed';
            batchEvent({
              type: 'job-progress',
              ...jobBase,
              message: `残留水印自动复检未完成：${auditError.message || auditError}；已保留当前结果`
            });
            break;
          }

          if (!audit.hasResidual) {
            residualStatus = autoRepairPasses > 0 ? 'repaired-clean' : 'clean';
            break;
          }

          const repairRegions = (Array.isArray(audit.regions) ? audit.regions : [])
            .filter((region) => Number(region.confidence) >= 0.62)
            .slice(0, 48);
          if (!repairRegions.length) {
            residualStatus = 'review';
            batchEvent({
              type: 'job-progress',
              ...jobBase,
              message: '检测到低置信度疑似标记，为避免误删真实场景文字，已保留当前结果供人工确认'
            });
            break;
          }
          if (autoRepairPasses >= maxAutoRepairPasses) {
            residualStatus = 'residual-after-max';
            batchEvent({
              type: 'job-progress',
              ...jobBase,
              message: '自动补修已达到 2 轮，仍检测到疑似残留，已保留当前最佳结果'
            });
            break;
          }

          const strokes = watermarkRegionsToStrokes(repairRegions, { brushPercent: 3 });
          if (!strokes.length) {
            residualStatus = 'review';
            break;
          }

          let markedUpload = null;
          let repairPadding = null;
          try {
            batchEvent({
              type: 'job-progress',
              ...jobBase,
              message: `检测到 ${repairRegions.length} 处疑似残留，正在自动定点补修第 ${autoRepairPasses + 1} 轮`
            });
            markedUpload = await prepareManualMarkedUpload({
              sourcePath: saved.path,
              nativeImage,
              temporaryDirectory: app.getPath('temp'),
              strokes,
              brushPercent: 3
            });

            const repairPrompt = buildManualEditPrompt(settings);
            const repairFirstPass = await automation.processImage({
              filePath: markedUpload.path,
              prompt: repairPrompt,
              newConversation: true,
              conversationId: '',
              imageWaitSeconds: settings.imageWaitSeconds
            });
            let repairCandidates = repairFirstPass.candidates;
            let repairUploadPath = markedUpload.path;

            // 自动补修同样使用原有的“接口直取优先 + 隔离带降级”链路，
            // 避免补修本身又把豆包页面水印带进最终结果。
            if (!repairFirstPass.apiRawHit && settings.addPaddingBeforeUpload && settings.cropMode !== 'never') {
              repairPadding = await preparePaddedUpload({
                sourcePath: markedUpload.path,
                nativeImage,
                temporaryDirectory: app.getPath('temp'),
                percent: settings.cropPercent,
                edge: settings.cropEdge
              });
              repairUploadPath = repairPadding.path;
              const repairSecondPass = await automation.processImage({
                filePath: repairUploadPath,
                prompt: repairPrompt,
                newConversation: true,
                conversationId: repairFirstPass.conversationId || '',
                imageWaitSeconds: settings.imageWaitSeconds
              });
              repairCandidates = repairSecondPass.candidates;
            }

            let repairCandidate;
            try {
              repairCandidate = await downloadBestImage({
                candidates: repairCandidates,
                electronSession: workerWindow.webContents.session,
                nativeImage,
                preferOriginal: settings.preferOriginal,
                onProgress: (message) => batchEvent({ type: 'job-progress', ...jobBase, message })
              });
            } catch (downloadError) {
              repairCandidate = await automation.captureLatestGeneratedCanvas(nativeImage, repairCandidates)
                .catch((canvasError) => {
                  throw new Error(`${downloadError.message}；自动补修高清画布兜底也失败：${canvasError.message}`);
                });
            }

            const repairMatchesUpload = !String(repairCandidate.source || '').startsWith('canvas')
              && (await isExactSourceImage(repairCandidate, repairUploadPath)
                || (repairUploadPath !== markedUpload.path && await isExactSourceImage(repairCandidate, markedUpload.path)));
            if (repairMatchesUpload) {
              repairCandidate = await automation.captureLatestGeneratedCanvas(nativeImage, repairCandidates)
                .catch((canvasError) => {
                  throw new Error(`自动补修返回了上传图而不是生成结果；高清画布导出也失败：${canvasError.message}`);
                });
            }

            const previousPath = saved.path;
            const repaired = await saveProcessedImage({
              candidate: repairCandidate,
              sourcePath,
              outputDirectory: settings.outputDirectory,
              settings,
              paddedUpload: repairPadding
            });

            // 能复用原文件名时原位替换，避免每轮补修留下 _cleaned-2/_cleaned-3 中间文件。
            if (path.extname(previousPath).toLowerCase() === path.extname(repaired.path).toLowerCase()) {
              await fs.rm(previousPath, { force: true }).catch(() => {});
              await fs.rename(repaired.path, previousPath);
              repaired.path = previousPath;
            } else {
              await fs.rm(previousPath, { force: true }).catch(() => {});
            }
            saved = repaired;
            autoRepairPasses += 1;
            residualStatus = 'repaired-pending-audit';
          } catch (repairError) {
            if (['CANCELLED', 'VERIFICATION_INTERRUPTED', 'LOGIN_RECOVERED_RESTART', 'LOGIN_RECOVERY_REQUIRED'].includes(repairError.code)) {
              await fs.rm(saved.path, { force: true }).catch(() => {});
              throw repairError;
            }
            residualStatus = 'repair-failed';
            batchEvent({
              type: 'job-progress',
              ...jobBase,
              message: `自动定点补修失败：${repairError.message || repairError}；已保留上一版有效结果`
            });
            break;
          } finally {
            if (markedUpload?.directory) {
              await fs.rm(markedUpload.directory, { recursive: true, force: true }).catch(() => {});
            }
            if (repairPadding?.directory) {
              await fs.rm(repairPadding.directory, { recursive: true, force: true }).catch(() => {});
            }
          }
        }
      }

      // 最终像素质检必须在覆盖原图之前完成；只有“残留复检通过 + 像素质检正常”才允许替换。
      let finalQc = null;
      try {
        finalQc = await runQcCheck(sourcePath, saved.path);
      } catch (qcError) {
        batchEvent({
          type: 'job-progress',
          ...jobBase,
          message: `最终质检未完成：${qcError.message || qcError}；不会覆盖原图`
        });
      }

      let overwriteStatus = settings.overwriteOriginal ? 'blocked-qc' : 'disabled';
      let overwroteOriginal = false;
      let refreshedSource = null;
      const overwriteDecision = overwriteGuard({
        enabled: settings.overwriteOriginal,
        mode,
        residualStatus,
        qcVerdict: finalQc?.verdict || 'unavailable'
      });

      if (overwriteDecision.allowed) {
        try {
          batchEvent({
            type: 'job-progress',
            ...jobBase,
            message: '最终复检和质检均通过，正在安全覆盖原图'
          });
          const replaced = await replaceOriginalSafely({
            sourcePath,
            resultPath: saved.path,
            nativeImage
          });
          saved = {
            ...saved,
            path: replaced.path,
            width: replaced.width,
            height: replaced.height
          };
          overwroteOriginal = true;
          overwriteStatus = 'overwritten';
          refreshedSource = (await validateImagePaths([sourcePath]))[0] || null;
          batchEvent({
            type: 'job-progress',
            ...jobBase,
            message: '已安全覆盖原图'
          });
        } catch (overwriteError) {
          overwriteStatus = overwriteError.code === 'UNSUPPORTED_ORIGINAL_FORMAT'
            ? 'unsupported-format'
            : 'failed';
          batchEvent({
            type: 'job-progress',
            ...jobBase,
            message: `${overwriteError.message || overwriteError}；原图保持不变`
          });
        }
      } else if (settings.overwriteOriginal) {
        overwriteStatus = overwriteDecision.reason;
        const reasonMessage = overwriteDecision.reason === 'manual-skip'
          ? '手动涂抹重绘不会自动覆盖原图，结果已保留在输出目录'
          : overwriteDecision.reason === 'blocked-residual'
            ? '残留水印最终复检未通过，不覆盖原图'
            : '最终像素质检未通过，不覆盖原图';
        batchEvent({ type: 'job-progress', ...jobBase, message: reasonMessage });
      }

      const result = {
        ...jobBase,
        ...saved,
        autoRepairPasses,
        residualAuditCount,
        residualStatus,
        overwroteOriginal,
        overwriteStatus,
        ...(refreshedSource ? { refreshedSource } : {}),
        conversationId: conversationId || taskConversationId || '',
        sourcePath: eventPath,
        outputPath: saved.path,
        path: eventPath
      };
      results.push(result);
      batchEvent({ type: 'job-complete', ...result });
      if (finalQc) {
        batchEvent({ type: 'job-qc', ...jobBase, outputPath: saved.path, qc: finalQc });
      }
    } catch (error) {
      if (error.code === 'CANCELLED' || cancelRef.value) return;
      if (error.code === 'VERIFICATION_INTERRUPTED') return 'retry-verification';
      if (error.code === 'LOGIN_RECOVERED_RESTART') return 'retry-login';
      if (error.code === 'LOGIN_RECOVERY_REQUIRED') {
        try {
          await recoverDoubaoLogin(workerWindow, {
            cancelRef,
            jobBase,
            keepVisible: settings.showBrowserWindow
          });
          return 'retry-login';
        } catch (recoveryError) {
          if (recoveryError.code === 'CANCELLED' || cancelRef.value) return;
          error = recoveryError;
        }
      }
      const result = {
        ...jobBase,
        error: error.message || String(error),
        conversationId: error.conversationId || taskConversationId || ''
      };
      results.push(result);
      batchEvent({ type: 'job-error', ...result });
    } finally {
      // 任务以任何方式结束（含取消、验证超时）都要释放验证领头资格，否则后续验证无人弹窗
      if (verificationGate.owner === verificationToken) verificationGate.owner = null;
      if (taskConversationId) inUseConversations.delete(taskConversationId);
      if (paddedUpload?.directory) {
        await fs.rm(paddedUpload.directory, { recursive: true, force: true }).catch(() => {});
      }
    }
  };

  // 安全验证与登录恢复都采用“恢复完成后整任务重跑”，避免继续使用可能已失效的上传/生成上下文。
  // 两类恢复分别计数：安全验证最多 2 次，登录恢复最多 3 次，互不占用彼此次数。
  const processAt = async (index, workerWindow) => {
    const maxVerificationRestarts = 2;
    const maxLoginRestarts = 3;
    let verificationRestarts = 0;
    let loginRestarts = 0;
    const epochRef = {
      verification: verificationEpoch.value,
      login: loginRecoveryEpoch.value
    };

    while (!cancelRef.value) {
      const outcome = await processAttempt(index, workerWindow, epochRef);
      if (!outcome || cancelRef.value) return;

      const file = files[index];
      const eventPath = files.length === 1 && runtime.eventPath ? runtime.eventPath : file.path;
      const sourcePath = files.length === 1 && runtime.sourcePath ? runtime.sourcePath : file.path;
      const common = {
        index,
        batchId,
        path: eventPath,
        name: path.basename(sourcePath),
        total: files.length,
        mode
      };

      if (outcome === 'retry-login') {
        loginRestarts += 1;
        if (loginRestarts > maxLoginRestarts) {
          const result = {
            ...common,
            error: '豆包登录会话多次恢复后仍异常，请稍后重新开始该任务',
            conversationId: typeof files[index].conversationId === 'string' ? files[index].conversationId : ''
          };
          results.push(result);
          batchEvent({ type: 'job-error', ...result });
          return;
        }
        if (workerWindow && !workerWindow.isDestroyed()) {
          await loadDoubaoChatForRecovery(workerWindow).catch(() => {});
        }
        epochRef.login = loginRecoveryEpoch.value;
        epochRef.verification = verificationEpoch.value;
        batchEvent({
          type: 'job-progress',
          ...common,
          message: `登录会话已恢复，正在重新开始当前任务（第 ${loginRestarts}/${maxLoginRestarts} 次）`
        });
        continue;
      }

      if (outcome === 'retry-verification') {
        verificationRestarts += 1;
        if (verificationRestarts > maxVerificationRestarts) {
          const result = {
            ...common,
            error: '安全验证后任务仍被中断，请稍后重新开始该任务',
            conversationId: typeof files[index].conversationId === 'string' ? files[index].conversationId : ''
          };
          results.push(result);
          batchEvent({ type: 'job-error', ...result });
          return;
        }
        // 验证是会话级风控；重跑前统一刷新聊天页，清掉当前窗口残留的挑战浮层。
        if (workerWindow && !workerWindow.isDestroyed()) {
          await Promise.race([
            workerWindow.loadURL(DOUBAO_CHAT_URL).catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 15_000))
          ]);
        }
        epochRef.verification = verificationEpoch.value;
        epochRef.login = loginRecoveryEpoch.value;
        batchEvent({
          type: 'job-progress',
          ...common,
          message: `安全验证已中断任务，正在重新开始（第 ${verificationRestarts}/${maxVerificationRestarts} 次）`
        });
        continue;
      }

      return;
    }
  };

  try {
    if (!useParallel) {
      for (let index = 0; index < files.length; index += 1) {
        if (cancelRef.value) break;
        await processAt(index, browser);
        if (index < files.length - 1 && !cancelRef.value && settings.intervalSeconds > 0) {
          batchEvent({ type: 'batch-wait', seconds: settings.intervalSeconds, nextIndex: index + 1 });
          await new Promise((resolve) => setTimeout(resolve, settings.intervalSeconds * 1000));
        }
      }
    } else {
      // 多线程：每个工作窗口独立取任务，全部同时启动，不做人为错峰。
      // 每个任务本身要经历开对话/上传/发送多个步骤，各窗口的请求节奏天然错开；
      // 偶发的安全验证由批次级验证兜底机制处理（暂停 → 手动完成 → 整批自动重启）
      let nextIndex = 0;
      const worker = async (workerWindow) => {
        while (!cancelRef.value) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= files.length) return;
          await processAt(index, workerWindow);
        }
      };
      await Promise.all(windows.map((workerWindow) => worker(workerWindow)));
    }
  } finally {
    releaseWindows();
    const cancelled = cancelRef.value;
    const completedCount = results.filter((item) => item.outputPath && !item.error).length;
    const failedCount = results.filter((item) => item.error).length;
    // 长跑任务切走窗口时，结束后弹系统通知叫用户回来（主窗口聚焦时不打扰）
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
      const isManual = mode === 'manual';
      const title = cancelled
        ? (isManual ? mt('局部重绘已停止', 'Local retouch stopped') : mt('批量处理已停止', 'Batch stopped'))
        : failedCount > 0
          ? (isManual ? mt('局部重绘失败', 'Local retouch failed') : mt('批量处理完成，但有失败', 'Batch finished with failures'))
          : (isManual ? mt('局部重绘完成', 'Local retouch done') : mt('批量处理全部完成', 'Batch complete'));
      const body = cancelled
        ? mt(`已停止，完成 ${completedCount}/${files.length} 张`, `Stopped — ${completedCount}/${files.length} done`)
        : failedCount > 0
          ? mt(`成功 ${completedCount} 张，失败 ${failedCount} 张，点击查看详情`, `${completedCount} succeeded, ${failedCount} failed — click for details`)
          : mt(`${completedCount} 张图片已保存到输出目录`, `${completedCount} image(s) saved to the output folder`);
      const notification = new Notification({ title, body });
      notification.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      });
      // 系统通知被拦截（macOS 未授权；开发模式下身份是 Electron 必然被拒）时兜底：
      // mac 弹跳 Dock 图标，Windows 闪烁任务栏按钮，保证用户离开时不至于完全没信号
      notification.on('failed', () => {
        if (process.platform === 'darwin') {
          app.dock?.bounce('informational');
        } else if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.flashFrame(true);
          mainWindow.once('focus', () => mainWindow.flashFrame(false));
        }
      });
      notification.show();
    }
    batchEvent({
      type: 'batch-complete',
      batchId,
      cancelled,
      total: files.length,
      completed: completedCount,
      failed: failedCount,
      outputDirectory: settings.outputDirectory,
      mode,
      path: runtime.eventPath || null
    });
  }
  return results;
}

async function runManualEdit(payload = {}) {
  const sourcePath = typeof payload.sourcePath === 'string' ? path.resolve(payload.sourcePath) : '';
  const [source] = await validateImagePaths([sourcePath]);
  if (!source) throw new Error('原图不存在或格式不受支持');
  // 涂抹发送也要接回该图片的历史会话（没有历史会话时自动化层会自动开新对话）
  const conversationId = typeof payload.conversationId === 'string' && /^[0-9a-zA-Z_-]{6,64}$/.test(payload.conversationId)
    ? payload.conversationId
    : '';
  const markedUpload = await prepareManualMarkedUpload({
    sourcePath: source.path,
    nativeImage,
    temporaryDirectory: app.getPath('temp'),
    strokes: payload.strokes,
    brushPercent: payload.brushPercent
  });
  try {
    return await runBatch([markedUpload.path], payload.settings, {
      mode: 'manual',
      eventPath: source.path,
      sourcePath: source.path,
      prompt: buildManualEditPrompt(payload.settings),
      persistSettings: false,
      files: [{
        ...source,
        path: markedUpload.path,
        name: path.basename(markedUpload.path),
        width: markedUpload.width,
        height: markedUpload.height,
        conversationId
      }]
    });
  } finally {
    await fs.rm(markedUpload.directory, { recursive: true, force: true }).catch(() => {});
  }
}

// 自动质检：对比原图与处理结果，识别"疑似未处理 / 差异过大"并生成差异热力图。
// 无额外图像依赖：用 nativeImage 解码，统一缩到相同尺寸（≤512）后逐像素比较；
// 热力图按输出路径命名（同名覆盖，不会越积越多），存于 userData/qc。
async function runQcCheck(sourcePath, outputPath) {
  const sourceImage = nativeImage.createFromPath(sourcePath);
  const outputImage = nativeImage.createFromPath(outputPath);
  if (sourceImage.isEmpty() || outputImage.isEmpty()) throw new Error('质检图片读取失败');
  const sourceSize = sourceImage.getSize();
  const outputSize = outputImage.getSize();
  const scale = Math.min(1, 512 / Math.max(sourceSize.width, sourceSize.height, outputSize.width, outputSize.height));
  const width = Math.max(1, Math.round(Math.min(sourceSize.width, outputSize.width) * scale));
  const height = Math.max(1, Math.round(Math.min(sourceSize.height, outputSize.height) * scale));
  // toBitmap 为 BGRA 排列：红色通道在下标 2
  const sourcePixels = sourceImage.resize({ width, height, quality: 'good' }).toBitmap();
  const outputPixels = outputImage.resize({ width, height, quality: 'good' }).toBitmap();
  const stats = computeDiffStats(sourcePixels, outputPixels);
  const verdict = verdictForStats(stats);
  const heatmapPixels = buildHeatmap(sourcePixels, outputPixels, width, height, 2);
  const heatmap = nativeImage.createFromBitmap(heatmapPixels, { width, height });
  const directory = path.join(app.getPath('userData'), 'qc');
  await fs.mkdir(directory, { recursive: true });
  const key = crypto.createHash('sha1').update(outputPath).digest('hex').slice(0, 12);
  const heatmapPath = path.join(directory, `${key}.png`);
  await fs.writeFile(heatmapPath, heatmap.toPNG());
  return { verdict, ...stats, heatmapPath };
}

async function getImagePreviewData(targetPath, maxSize) {
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
    throw new Error('预览路径无效');
  }
  if (!SUPPORTED_EXTENSIONS.has(path.extname(targetPath).toLowerCase())) {
    throw new Error('该文件格式不支持预览');
  }
  const stat = await fs.stat(targetPath);
  if (!stat.isFile() || stat.size > 80 * 1024 * 1024) throw new Error('预览文件无效或过大');
  const image = nativeImage.createFromPath(targetPath);
  if (image.isEmpty()) throw new Error('无法读取处理结果');
  const { width, height } = image.getSize();
  // maxSize 不传时按预览大图处理（2560），传了则夹在 64-2560（如悬停气泡的 480）
  const requested = Math.round(Number(maxSize)) || 0;
  const limit = requested ? Math.min(2560, Math.max(64, requested)) : 2560;
  const scale = Math.min(1, limit / width, limit / height);
  const preview = scale < 1
    ? image.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'good'
    })
    : image;
  return {
    name: path.basename(targetPath),
    width,
    height,
    dataUrl: preview.toDataURL()
  };
}

async function openImagePreviewWindow(payload) {
  // 兼容旧的纯路径入参；新入参 { targetPath, sourcePath } 会附带原图用于前后对比
  const targetPath = typeof payload === 'string' ? payload : payload?.targetPath;
  const sourcePath = typeof payload === 'object' && payload ? payload.sourcePath : '';
  const preview = await getImagePreviewData(targetPath);
  // 原图可能已被移动或删除，加载失败时不影响结果预览
  preview.source = await getImagePreviewData(sourcePath).catch(() => null);
  // 有原图时附带质检差异热力图（质检失败不影响预览）
  preview.qc = sourcePath
    ? await runQcCheck(sourcePath, targetPath)
        .then(async (qc) => ({
          verdict: qc.verdict,
          changedRatio: qc.changedRatio,
          meanDiff: qc.meanDiff,
          heatmap: await getImagePreviewData(qc.heatmapPath).catch(() => null)
        }))
        .catch(() => null)
    : null;
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.setTitle(`${mt('预览', 'Preview')} · ${preview.name}`);
    previewWindow.webContents.send('preview:load', preview);
    if (previewWindow.isMinimized()) previewWindow.restore();
    previewWindow.show();
    previewWindow.focus();
    return true;
  }

  previewWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#101714',
    icon: APP_ICON_PATH,
    title: `${mt('预览', 'Preview')} · ${preview.name}`,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 18 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preview-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  previewWindow.loadFile(path.join(__dirname, 'renderer', 'preview-window.html'));
  applyPlatformWindowTweaks(previewWindow);
  previewWindow.once('ready-to-show', () => {
    if (!previewWindow || previewWindow.isDestroyed()) return;
    previewWindow.show();
    previewWindow.focus();
  });
  previewWindow.webContents.once('did-finish-load', () => {
    if (previewWindow && !previewWindow.isDestroyed()) previewWindow.webContents.send('preview:load', preview);
  });
  previewWindow.on('closed', () => {
    previewWindow = null;
  });
  return true;
}

async function openManualEditWindow(payload = {}) {
  const sourcePath = typeof payload.path === 'string' ? payload.path : '';
  if (!sourcePath || !path.isAbsolute(sourcePath)) throw new Error('涂抹原图路径无效');
  if (!SUPPORTED_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
    throw new Error('该文件格式不支持涂抹');
  }
  const file = { path: sourcePath, name: path.basename(sourcePath) };
  if (manualWindow && !manualWindow.isDestroyed()) {
    manualWindow.setTitle(`${mt('手动涂抹', 'Brush retouch')} · ${file.name}`);
    manualWindow.webContents.send('manual:load', file);
    if (manualWindow.isMinimized()) manualWindow.restore();
    manualWindow.show();
    manualWindow.focus();
    return true;
  }

  manualWindow = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#101714',
    icon: APP_ICON_PATH,
    title: `${mt('手动涂抹', 'Brush retouch')} · ${file.name}`,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 18 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'manual-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  manualWindow.loadFile(path.join(__dirname, 'renderer', 'manual-window.html'));
  applyPlatformWindowTweaks(manualWindow);
  manualWindow.once('ready-to-show', () => {
    if (!manualWindow || manualWindow.isDestroyed()) return;
    manualWindow.show();
    manualWindow.focus();
  });
  manualWindow.webContents.once('did-finish-load', () => {
    if (manualWindow && !manualWindow.isDestroyed()) manualWindow.webContents.send('manual:load', file);
  });
  manualWindow.on('closed', () => {
    manualWindow = null;
  });
  return true;
}

function openAdvancedSettingsWindow() {
  if (advancedWindow && !advancedWindow.isDestroyed()) {
    if (advancedWindow.isMinimized()) advancedWindow.restore();
    advancedWindow.show();
    advancedWindow.focus();
    return true;
  }

  advancedWindow = new BrowserWindow({
    width: 620,
    height: 680,
    minWidth: 540,
    minHeight: 620,
    backgroundColor: '#f5f4ef',
    icon: APP_ICON_PATH,
    title: mt('高级处理设置', 'Advanced settings'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 18 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'advanced-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  advancedWindow.loadFile(path.join(__dirname, 'renderer', 'advanced-window.html'));
  applyPlatformWindowTweaks(advancedWindow);
  advancedWindow.once('ready-to-show', () => {
    if (!advancedWindow || advancedWindow.isDestroyed()) return;
    advancedWindow.show();
    advancedWindow.focus();
  });
  advancedWindow.on('closed', () => {
    advancedWindow = null;
  });
  return true;
}

function registerIpc() {
  ipcMain.handle('settings:get', loadSettings);
  ipcMain.handle('advanced:open', () => openAdvancedSettingsWindow());
  ipcMain.handle('advanced:save', async (_event, value) => {
    const settings = await saveSettings(value);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:updated', settings);
    return settings;
  });
  ipcMain.on('advanced:close', () => {
    if (advancedWindow && !advancedWindow.isDestroyed()) advancedWindow.close();
  });
  ipcMain.handle('settings:save', async (_event, value) => {
    const saved = await saveSettings(value);
    applyAppearanceSideEffects(saved);
    return saved;
  });
  ipcMain.handle('queue:get', loadQueueRecords);
  ipcMain.handle('queue:save', (_event, records) => saveQueueRecords(records));
  ipcMain.handle('login:open', openDoubaoLogin);
  ipcMain.handle('login:logout', logoutDoubao);
  ipcMain.handle('login:status', getLoginStatus);
  ipcMain.handle('files:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mt('选择要去水印的图片', 'Choose images to clean'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: mt('图片', 'Images'), extensions: [...SUPPORTED_EXTENSIONS].map((item) => item.slice(1)) }]
    });
    return result.canceled ? [] : validateImagePaths(result.filePaths);
  });
  ipcMain.handle('files:validate', (_event, paths) => validateImagePaths(paths));
  // 剪贴板粘贴入队：把渲染进程传来的图片字节落盘到收件箱，再走统一的校验/缩略图管线
  ipcMain.handle('files:save-clipboard', async (_event, payload) => {
    const buffer = Buffer.from(payload?.buffer || []);
    if (!buffer.length || buffer.length > 80 * 1024 * 1024) return null;
    const extByMime = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/gif': '.gif' };
    const ext = extByMime[payload?.mimeType] || '.png';
    const directory = path.join(app.getPath('userData'), 'clipboard-inbox');
    await fs.mkdir(directory, { recursive: true });
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    let filePath = path.join(directory, `剪贴板-${stamp}${ext}`);
    for (let seq = 2; fsSync.existsSync(filePath); seq += 1) {
      filePath = path.join(directory, `剪贴板-${stamp}-${seq}${ext}`);
    }
    await fs.writeFile(filePath, buffer);
    // 收件箱只留最近 50 张，避免无限膨胀
    const inbox = (await fs.readdir(directory)).filter((name) => name.startsWith('剪贴板-')).sort();
    for (const stale of inbox.slice(0, Math.max(0, inbox.length - 50))) {
      await fs.rm(path.join(directory, stale), { force: true }).catch(() => {});
    }
    const [file] = await validateImagePaths([filePath]);
    return file || null;
  });
  ipcMain.handle('image:preview', (_event, targetPath, maxSize) => getImagePreviewData(targetPath, maxSize));
  ipcMain.handle('image:open-preview', (_event, targetPath) => openImagePreviewWindow(targetPath));
  ipcMain.handle('manual:open', (_event, payload) => openManualEditWindow(payload));
  ipcMain.on('manual:submit', (_event, payload) => {
    if (manualWindow && !manualWindow.isDestroyed()) manualWindow.close();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('manual:submitted', payload);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  ipcMain.on('manual:close', () => {
    if (manualWindow && !manualWindow.isDestroyed()) manualWindow.close();
  });
  ipcMain.handle('output:select', async (_event, currentDirectory) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mt('选择输出文件夹', 'Choose the output folder'),
      defaultPath: currentDirectory || (IS_OHOS ? app.getPath('userData') : app.getPath('pictures')),
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('batch:start', (_event, payload) => runBatch(payload?.paths, payload?.settings));
  ipcMain.handle('manual:start', (_event, payload) => runManualEdit(payload));
  ipcMain.handle('batch:cancel', () => {
    activeCancelRefs.forEach((ref) => { ref.value = true; });
    return activeCancelRefs.size > 0;
  });
  ipcMain.handle('path:open', async (_event, targetPath) => {
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) return '无效路径';
    return shell.openPath(targetPath);
  });
  // 一键导出：把已完成任务的输出图打包成 zip（导出哪些由渲染进程决定：勾选项优先，否则全部已完成）
  ipcMain.handle('export:zip', async (_event, payload) => {
    const paths = (Array.isArray(payload?.paths) ? payload.paths : [])
      .filter((item) => typeof item === 'string' && path.isAbsolute(item));
    if (!paths.length) return { exported: 0 };
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const defaultName = `${mt('水印清理结果', 'watermark-lab-export')}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: mt('导出为 ZIP', 'Export as ZIP'),
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [{ name: mt('ZIP 压缩包', 'ZIP archive'), extensions: ['zip'] }]
    });
    if (canceled || !filePath) return { cancelled: true };
    // zip 内文件名按输出文件名，重名时追加序号
    const used = new Set();
    const entries = [];
    for (const item of paths) {
      const ext = path.extname(item);
      const base = path.basename(item, ext) || 'image';
      let name = `${base}${ext}`;
      let seq = 2;
      while (used.has(name.toLowerCase())) {
        name = `${base} (${seq})${ext}`;
        seq += 1;
      }
      used.add(name.toLowerCase());
      entries.push({ name, path: item });
    }
    const exported = await writeZipFile(filePath, entries);
    return { exported, zipPath: filePath };
  });
}

// 去掉系统菜单栏后，macOS 的文本编辑快捷键（⌘C/⌘V 等）会随菜单一起消失，这里按窗口补回
const MENULESS_EDIT_ACTIONS = new Map([
  ['c', 'copy'],
  ['v', 'paste'],
  ['x', 'cut'],
  ['a', 'selectAll']
]);

function registerEditShortcuts() {
  if (process.platform !== 'darwin') return;
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'window') return;
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.meta || input.control || input.alt) return;
      const key = (input.key || '').toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (input.shift) contents.redo();
        else contents.undo();
        return;
      }
      if (key === 'w') {
        event.preventDefault();
        BrowserWindow.fromWebContents(contents)?.close();
        return;
      }
      if (key === 'q') {
        event.preventDefault();
        app.quit();
        return;
      }
      const action = MENULESS_EDIT_ACTIONS.get(key);
      if (!action) return;
      event.preventDefault();
      contents[action]();
    });
  });
}

// 自动更新：启动后静默检查，之后每 4 小时复查一次。
// Windows 安装版：electron-updater 后台下载 setup 安装包，下载完成后询问是否重启安装。
// Windows 便携版：electron-updater 不识别便携包，走 GitHub API 半自动流程，下载新版便携包到 exe 所在目录。
// macOS：未签名包无法使用 Squirrel 自动安装，走 GitHub API 检查 + 下载 dmg 引导手动替换（半自动更新）
let macUpdateInProgress = false;
async function checkMacUpdate() {
  const { newerVersionFromRelease, pickReleaseAsset, summarizeReleaseNotes } = require('./update-check');
  const response = await fetch('https://api.github.com/repos/littlestone0806/doubao-watermark-lab/releases/latest', {
    headers: { 'User-Agent': 'watermark-lab-updater', Accept: 'application/vnd.github+json' }
  });
  if (!response.ok) return;
  const release = await response.json();
  const latest = newerVersionFromRelease(release, app.getVersion());
  if (!latest || macUpdateInProgress) return;
  macUpdateInProgress = true;
  const notes = summarizeReleaseNotes(release.body);
  try {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: mt('发现新版本', 'Update available'),
      message: mt(`新版本 ${latest} 已发布（当前 ${app.getVersion()}）`, `Version ${latest} is out (current ${app.getVersion()})`),
      detail: `${notes ? `${notes}\n\n` : ''}${mt('由于应用未做 Apple 签名，macOS 无法自动安装更新。点击“立即下载”将为你下载安装包并打开，拖入「应用程序」替换即可。', 'The app is not Apple-signed, so macOS cannot auto-install updates. Click "Download now" to fetch and open the installer, then drag it into Applications to replace the old version.')}`,
      buttons: [mt('立即下载', 'Download now'), mt('稍后', 'Later')],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (choice.response !== 0) return;
    const asset = pickReleaseAsset(release, /mac-arm64\.dmg$/i);
    if (!asset) {
      shell.openExternal(release.html_url);
      return;
    }
    sendToRenderer('app:event', { type: 'update-downloading', version: latest });
    const target = path.join(app.getPath('downloads'), asset.name);
    const downloadResponse = await fetch(asset.url, {
      headers: { 'User-Agent': 'watermark-lab-updater' },
      redirect: 'follow'
    });
    if (!downloadResponse.ok) throw new Error(`下载失败 HTTP ${downloadResponse.status}`);
    const buffer = Buffer.from(await downloadResponse.arrayBuffer());
    await fs.writeFile(target, buffer);
    const openChoice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: mt('下载完成', 'Download complete'),
      message: mt(`新版本 ${latest} 安装包已下载完成`, `The version ${latest} installer has been downloaded`),
      detail: mt('打开 dmg 后把应用拖入「应用程序」替换旧版即可。', 'Open the dmg and drag the app into Applications to replace the old version.'),
      buttons: [mt('打开安装包', 'Open installer'), mt('稍后', 'Later')],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (openChoice.response === 0) shell.openPath(target);
  } finally {
    macUpdateInProgress = false;
  }
}

// Windows 便携版更新：electron-updater 不识别便携包（会错把 setup 安装包装进系统），
// 改为 GitHub API 检查 + 下载新版便携包到当前 exe 所在目录，用户关闭软件后运行新文件即可
let portableUpdateInProgress = false;
async function checkPortableUpdate() {
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!portableExe || portableUpdateInProgress) return;
  const { newerVersionFromRelease, pickReleaseAsset, portableAssetPattern, summarizeReleaseNotes } = require('./update-check');
  const response = await fetch('https://api.github.com/repos/littlestone0806/doubao-watermark-lab/releases/latest', {
    headers: { 'User-Agent': 'watermark-lab-updater', Accept: 'application/vnd.github+json' }
  });
  if (!response.ok) return;
  const release = await response.json();
  const latest = newerVersionFromRelease(release, app.getVersion());
  if (!latest) return;
  const asset = pickReleaseAsset(release, portableAssetPattern(process.arch));
  if (!asset) return;
  portableUpdateInProgress = true;
  const notes = summarizeReleaseNotes(release.body);
  try {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: mt('发现新版本', 'Update available'),
      message: mt(`新版本 ${latest} 已发布（当前 ${app.getVersion()}）`, `Version ${latest} is out (current ${app.getVersion()})`),
      detail: `${notes ? `${notes}\n\n` : ''}${mt('将下载新版便携包到当前软件所在目录，下载完成后关闭软件、运行新文件即可。', 'The new portable build will be downloaded next to the current app; close the app and run the new file when done.')}`,
      buttons: [mt('立即下载', 'Download now'), mt('稍后', 'Later')],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (choice.response !== 0) return;
    sendToRenderer('app:event', { type: 'update-downloading', version: latest });
    const downloadResponse = await fetch(asset.url, {
      headers: { 'User-Agent': 'watermark-lab-updater' },
      redirect: 'follow'
    });
    if (!downloadResponse.ok) throw new Error(`下载失败 HTTP ${downloadResponse.status}`);
    const buffer = Buffer.from(await downloadResponse.arrayBuffer());
    // 优先写到便携 exe 所在目录；无写权限（如 Program Files）时回退到系统下载目录
    let target = path.join(path.dirname(portableExe), asset.name);
    try {
      await fs.writeFile(target, buffer);
    } catch {
      target = path.join(app.getPath('downloads'), asset.name);
      await fs.writeFile(target, buffer);
    }
    const doneChoice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: mt('下载完成', 'Download complete'),
      message: mt(`新版本 ${latest} 便携包已下载完成`, `The version ${latest} portable build has been downloaded`),
      detail: mt(`已保存到：${path.dirname(target)}\n关闭软件后运行新的 ${asset.name} 即可，旧文件可手动删除。`, `Saved to: ${path.dirname(target)}\nClose the app and run the new ${asset.name}; the old file can be deleted.`),
      buttons: [mt('打开所在目录', 'Show in folder'), mt('好的', 'OK')],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (doneChoice.response === 0) shell.showItemInFolder(target);
  } finally {
    portableUpdateInProgress = false;
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  // 鸿蒙暂无更新渠道（后续走应用市场），不做 GitHub 更新检查
  if (IS_OHOS) return;
  if (process.platform === 'darwin') {
    const check = () => checkMacUpdate().catch(() => {});
    setTimeout(check, 6_000);
    setInterval(check, 4 * 60 * 60 * 1000);
    return;
  }
  // Windows 便携版走独立更新流程：下载新版便携包到 exe 所在目录，不走 electron-updater 安装
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE) {
    const check = () => checkPortableUpdate().catch(() => {});
    setTimeout(check, 6_000);
    setInterval(check, 4 * 60 * 60 * 1000);
    return;
  }
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => {
    sendToRenderer('app:event', { type: 'update-available', version: info?.version || '' });
  });
  autoUpdater.on('update-downloaded', async (info) => {
    const version = info?.version ? ` ${info.version}` : '';
    // GitHub 源的 releaseNotes 是 release 正文转成的 HTML，摘要函数内部会先剥标签
    const { summarizeReleaseNotes } = require('./update-check');
    const rawNotes = Array.isArray(info?.releaseNotes)
      ? info.releaseNotes.map((item) => item?.note || '').join('\n')
      : info?.releaseNotes || '';
    const notes = summarizeReleaseNotes(rawNotes);
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: mt('更新已就绪', 'Update ready'),
      message: mt(`新版本${version}已下载完成`, `Version${version} has been downloaded`),
      detail: `${notes ? `${notes}\n\n` : ''}${mt('重启应用后即可使用新版本；选择“稍后”则下次退出时自动安装。', 'Restart to use the new version; choose "Later" to install automatically on next quit.')}`,
      buttons: [mt('立即重启', 'Restart now'), mt('稍后', 'Later')],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (choice.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (error) => {
    console.warn(`自动更新检查失败：${error?.message || error}`);
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 6_000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

app.whenReady().then(async () => {
  // 应用不使用系统菜单栏（macOS 顶部菜单与 Windows 窗口菜单一并移除）
  Menu.setApplicationMenu(null);
  registerEditShortcuts();
  // 最先读设置：托盘菜单、窗口标题等主进程侧文案都需要知道当前语言
  const settings = await loadSettings();
  // 鸿蒙系统限制：窗口的显示/隐藏与托盘强绑定，创建窗口前必须先有托盘，
  // 否则工作窗口 hide/show（隐藏处理、验证时弹出）会失效
  if (IS_OHOS) {
    try {
      ohosTray = new Tray(nativeImage.createFromPath(APP_ICON_PATH));
      ohosTray.setToolTip(APP_DISPLAY_NAME);
      ohosTray.setContextMenu(Menu.buildFromTemplate([
        { label: mt('打开主窗口', 'Open main window'), click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); } },
        { label: mt('退出', 'Quit'), click: () => app.quit() }
      ]));
    } catch (error) {
      console.warn(`鸿蒙托盘创建失败（窗口显隐可能受影响）：${error?.message || error}`);
    }
    // 申请剪贴板读取权限（截图粘贴入队依赖；系统弹窗只出现一次）
    systemPreferences.requestSystemPermission?.('pasteboard')?.catch?.(() => {});
  }
  configureDoubaoSession();
  registerIpc();
  createMainWindow();
  setupAutoUpdater();
  // 按当前主题色着色 Dock/窗口图标与 Windows 标题栏按钮（窗口创建后调用一并生效）
  applyAppearanceSideEffects(settings);
  nativeTheme.on('updated', () => {
    if (lastAppliedSettings?.themeMode === 'auto') applyAppearanceSideEffects(lastAppliedSettings);
  });
  await broadcastLoginStatus();
  app.on('activate', () => {
    // 退出过程中不再重建窗口，避免关闭后 Dock 点击又拉起主窗口
    if (!appQuitting && BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  if (ohosTray) {
    try { ohosTray.destroy(); } catch { /* 已销毁 */ }
    ohosTray = null;
  }
});

let appQuitting = false;
app.on('before-quit', () => {
  appQuitting = true;
  clearInterval(loginTimer);
  activeCancelRefs.forEach((ref) => { ref.value = true; });
  // 强制销毁所有窗口：豆包页面可能带 beforeunload，优雅关闭可能被拦截导致进程残留
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.destroy();
  }
});
