'use strict';

const api = window.watermarkLab;
const t = (key, params) => window.wlI18n.t(key, params);
const state = {
  files: [],
  running: false,
  loggedIn: false,
  settings: null,
  activeBatches: new Set(),
  queueReady: false
};

const elements = {
  loginPill: document.querySelector('#loginPill'),
  loginText: document.querySelector('#loginText'),
  loginButton: document.querySelector('#loginButton'),
  loginButtonText: document.querySelector('#loginButtonText'),
  logoutButton: document.querySelector('#logoutButton'),
  dropZone: document.querySelector('#dropZone'),
  emptyState: document.querySelector('#emptyState'),
  queueList: document.querySelector('#queueList'),
  queueListToolbar: document.querySelector('#queueListToolbar'),
  queueCount: document.querySelector('#queueCount'),
  clearButton: document.querySelector('#clearButton'),
  selectAllCheckbox: document.querySelector('#selectAllCheckbox'),
  intervalSeconds: document.querySelector('#intervalSeconds'),
  imageWaitSeconds: document.querySelector('#imageWaitSeconds'),
  parallelProcessing: document.querySelector('#parallelProcessing'),
  maxConcurrentControl: document.querySelector('#maxConcurrentControl'),
  maxConcurrentTasks: document.querySelector('#maxConcurrentTasks'),
  strategySummaryText: document.querySelector('#strategySummaryText'),
  advancedSettingsButton: document.querySelector('#advancedSettingsButton'),
  overwriteOriginal: document.querySelector('#overwriteOriginal'),
  showBrowserWindow: document.querySelector('#showBrowserWindow'),
  themeModeButtons: [...document.querySelectorAll('[data-theme-mode]')],
  languageButtons: [...document.querySelectorAll('[data-language]')],
  paletteButtons: [...document.querySelectorAll('[data-palette]')],
  themeColor: document.querySelector('#themeColor'),
  themeColorValue: document.querySelector('#themeColorValue'),
  customColorControl: document.querySelector('#customColorControl'),
  appearanceToggle: document.querySelector('#appearanceToggle'),
  appearanceColors: document.querySelector('#appearanceColors'),
  outputButton: document.querySelector('#outputButton'),
  outputPath: document.querySelector('#outputPath'),
  outputHint: document.querySelector('#outputHint'),
  openOutputButton: document.querySelector('#openOutputButton'),
  exportZipButton: document.querySelector('#exportZipButton'),
  cancelButton: document.querySelector('#cancelButton'),
  startButton: document.querySelector('#startButton'),
  startCount: document.querySelector('#startCount'),
  toastRegion: document.querySelector('#toastRegion'),
  thumbPopover: document.querySelector('#thumbPopover'),
  thumbPopoverImage: document.querySelector('#thumbPopoverImage')
};

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatPercent(value) {
  const number = Number(value) || 0;
  return `${Number.isInteger(number) ? number : number.toFixed(1)}%`;
}

function toast(message, type = 'info') {
  const item = document.createElement('div');
  item.className = `toast ${type === 'error' ? 'error' : ''}`;
  item.textContent = message;
  elements.toastRegion.append(item);
  setTimeout(() => item.remove(), 4600);
}

function readSettings() {
  return {
    ...state.settings,
    outputDirectory: state.settings.outputDirectory,
    showBrowserWindow: elements.showBrowserWindow.checked,
    overwriteOriginal: elements.overwriteOriginal.checked,
    intervalSeconds: Math.min(600, Math.max(0, Math.round(Number(elements.intervalSeconds.value) || 0))),
    imageWaitSeconds: Math.min(300, Math.max(5, Math.round(Number(elements.imageWaitSeconds.value) || 60))),
    parallelProcessing: elements.parallelProcessing.checked,
    maxConcurrentTasks: Math.min(8, Math.max(1, Math.round(Number(elements.maxConcurrentTasks.value) || 3)))
  };
}

let saveTimer;
function scheduleSettingsSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!state.settings) return;
    state.settings = await api.saveSettings(readSettings());
  }, 450);
}

function applySettings(settings) {
  state.settings = settings;
  applyAppearance(settings);
  elements.showBrowserWindow.checked = settings.showBrowserWindow;
  elements.overwriteOriginal.checked = settings.overwriteOriginal === true;
  elements.intervalSeconds.value = String(settings.intervalSeconds ?? 30);
  elements.imageWaitSeconds.value = String(settings.imageWaitSeconds ?? 60);
  elements.parallelProcessing.checked = settings.parallelProcessing === true;
  elements.maxConcurrentTasks.value = String(settings.maxConcurrentTasks ?? 3);
  syncProcessingControls();
  elements.outputPath.textContent = settings.outputDirectory;
  elements.outputPath.title = settings.outputDirectory;
  elements.outputHint.textContent = settings.overwriteOriginal
    ? t('通过最终复检和质检的图片会安全覆盖原文件；未通过的结果仍保存在输出目录')
    : t('处理完成的图片会自动保存到这里');
  const edgeName = settings.cropEdge === 'bottom' ? t('底部') : t('顶部');
  elements.strategySummaryText.textContent = t('{edge}添加 {p} 临时隔离带，白边补偿 {q}。', {
    edge: edgeName,
    p: formatPercent(settings.cropPercent),
    q: formatPercent(settings.cropCompensationPercent)
  });
  elements.languageButtons.forEach((button) => {
    const active = button.dataset.language === (settings.language || 'zh');
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

const PRESET_COLORS = Object.freeze({
  forest: '#246b55',
  ocean: '#28739a',
  violet: '#745ca7',
  sunset: '#b9663e',
  graphite: '#53636a'
});

function themeColorParts(value) {
  const hex = /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : PRESET_COLORS.forest;
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  const darken = (channel) => Math.round(channel * 0.68).toString(16).padStart(2, '0');
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return {
    hex,
    rgb: `${red}, ${green}, ${blue}`,
    deep: `#${darken(red)}${darken(green)}${darken(blue)}`,
    contrast: luminance > 0.68 ? '#14201b' : '#f7fffb'
  };
}

function applyAppearance(settings) {
  const root = document.documentElement;
  const color = themeColorParts(settings.themeColor || PRESET_COLORS[settings.colorPalette]);
  root.dataset.theme = settings.themeMode || 'auto';
  root.dataset.palette = settings.colorPalette || 'forest';
  root.style.setProperty('--accent', color.hex);
  root.style.setProperty('--accent-deep', color.deep);
  root.style.setProperty('--accent-rgb', color.rgb);
  root.style.setProperty('--accent-contrast', color.contrast);
  elements.themeColor.value = color.hex;
  elements.themeColorValue.value = color.hex.toUpperCase();
  elements.themeColorValue.textContent = color.hex.toUpperCase();
  const customActive = settings.colorPalette === 'custom';
  elements.customColorControl.classList.toggle('is-active', customActive);
  elements.themeModeButtons.forEach((button) => {
    const active = button.dataset.themeMode === settings.themeMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  elements.paletteButtons.forEach((button) => {
    const active = button.dataset.palette === settings.colorPalette;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

async function openPreview(file) {
  if (!file.outputPath) return;
  try {
    await api.openPreviewWindow({ targetPath: file.outputPath, sourcePath: file.path });
  } catch (error) {
    toast(t(error.message || String(error)), 'error');
  }
}

async function openManualEditor(file) {
  try {
    await api.openManualWindow({ path: file.path, name: file.name });
  } catch (error) {
    toast(t(error.message || String(error)), 'error');
  }
}

async function startBatchForFiles(files) {
  const settings = readSettings();
  state.settings = await api.saveSettings(settings);
  try {
    await api.startBatch({
      paths: files.map((file) => ({ path: file.path, conversationId: file.conversationId || '' })),
      settings: state.settings
    });
  } catch (error) {
    files.forEach((file) => { file.regenRequested = false; });
    if (state.activeBatches.size) renderQueue();
    else setRunning(false);
    toast(t(error.message || String(error)), 'error');
  }
}

// 单张重新生成：效果等同于只勾选这一张再点“开始批量处理”。
// 其他任务正在运行时点击会立即并发执行（同时处理的任务数由设置决定）。
async function regenerateFile(file) {
  if (file.missing || file.regenRequested || file.status === 'active') return;
  const maxConcurrent = state.settings?.maxConcurrentTasks || 3;
  if (state.activeBatches.size >= maxConcurrent) {
    toast(t('最多同时处理 {n} 张图片，请等待其中一张完成', { n: maxConcurrent }), 'error');
    return;
  }
  updateFile(file.path, { regenRequested: true });
  await startBatchForFiles([file]);
}

async function handleManualSubmitted(payload = {}) {
  const sourcePath = typeof payload.sourcePath === 'string' ? payload.sourcePath : '';
  const strokes = Array.isArray(payload.strokes) ? payload.strokes : [];
  if (!sourcePath || !strokes.length) return;
  const maxConcurrent = state.settings?.maxConcurrentTasks || 3;
  if (state.activeBatches.size >= maxConcurrent) {
    toast(t('最多同时处理 {n} 张图片，请等待其中一张完成', { n: maxConcurrent }), 'error');
    return;
  }
  const file = state.files.find((item) => item.path === sourcePath);
  setRunning(true);
  if (file) updateFile(file.path, { status: 'active', message: '正在生成涂抹标记', progress: 5 });
  try {
    await api.startManualEdit({
      sourcePath,
      strokes,
      brushPercent: Number(payload.brushPercent) || 3,
      conversationId: file?.conversationId || '',
      settings: readSettings()
    });
  } catch (error) {
    if (state.activeBatches.size) renderQueue();
    else setRunning(false);
    if (file) updateFile(file.path, { status: file.outputPath ? 'complete' : 'error', message: '' });
    toast(t(error.message || String(error)), 'error');
  }
}

function progressForMessage(message, current = 0) {
  const text = String(message || '');
  const resourceMatch = text.match(/(\d+)\s*\/\s*(\d+)/);
  let progress = current;
  if (/准备处理/.test(text)) progress = 5;
  else if (/创建新对话/.test(text)) progress = 9;
  else if (/临时空白|添加.*空白/.test(text)) progress = 14;
  else if (/上传原图/.test(text)) progress = 24;
  else if (/填写处理指令/.test(text)) progress = 34;
  else if (/工作窗口异常|重新创建豆包工作窗口|自动重跑|登录状态异常|恢复豆包登录|刷新豆包会话|重置豆包工作窗口|需要重新登录|登录会话已恢复|会话已自动恢复|登录状态正常/.test(text)) progress = Math.max(current, 10);
  else if (/安全验证/.test(text)) progress = Math.max(current, 42);
  else if (/重绘图片/.test(text)) progress = 56;
  else if (resourceMatch) progress = 68 + Math.round((Number(resourceMatch[1]) / Math.max(1, Number(resourceMatch[2]))) * 14);
  else if (/原生保存|下载/.test(text)) progress = 84;
  else if (/高清预览|高清画布|生成结果画布/.test(text)) progress = 90;
  else if (/自动定点补修/.test(text)) progress = Math.max(current, 92);
  else if (/全图复检|同会话复检|当前会话直接复检|残留水印/.test(text)) progress = Math.max(current, 94);
  else if (/安全覆盖原图|覆盖原图/.test(text)) progress = Math.max(current, 97);
  return Math.min(96, Math.max(current, progress));
}

function syncProcessingControls() {
  elements.parallelProcessing.disabled = state.running;
  elements.overwriteOriginal.disabled = state.running;
  elements.imageWaitSeconds.disabled = state.running;
  elements.intervalSeconds.disabled = state.running || elements.parallelProcessing.checked;
  elements.maxConcurrentControl.classList.toggle('is-hidden', !elements.parallelProcessing.checked);
  elements.maxConcurrentTasks.disabled = state.running || !elements.parallelProcessing.checked;
}

function syncActionState() {
  const selectedCount = state.files.filter((file) => file.selected !== false).length;
  elements.queueCount.textContent = t('{n} 张', { n: state.files.length });
  elements.startCount.textContent = String(selectedCount);
  // 即使当前检测为未登录也允许启动：主进程会自动恢复持久会话，
  // 真正需要扫码/短信时暂停任务并弹出唯一登录窗口，登录成功后自动续跑。
  elements.startButton.disabled = state.running || !selectedCount;
  elements.clearButton.disabled = state.running || !state.files.length;
  elements.dropZone.disabled = state.running;
  elements.selectAllCheckbox.disabled = state.running || !state.files.length;
  elements.selectAllCheckbox.checked = selectedCount > 0 && selectedCount === state.files.length;
  elements.selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < state.files.length;
  syncProcessingControls();
  elements.cancelButton.classList.toggle('is-hidden', !state.running);
  elements.startButton.classList.toggle('is-hidden', state.running);
  const canExport = !state.running && state.files.some((file) => file.status === 'complete' && file.outputPath && file.selected !== false);
  elements.exportZipButton.disabled = !canExport;
  // 无可导出项时与"打开输出目录"同为幽灵样式；有可导出项时提为次要按钮提示可用
  elements.exportZipButton.classList.toggle('secondary', canExport);
  elements.exportZipButton.classList.toggle('ghost', !canExport);
  elements.emptyState.classList.toggle('is-hidden', state.files.length > 0);
  elements.queueListToolbar.classList.toggle('is-hidden', state.files.length === 0);
}

// 悬停原图缩略图时展示的放大气泡；预览图按路径缓存，最多保留 30 张
const thumbPreviewCache = new Map();
let thumbHoverToken = 0;
let thumbHoverTimer = 0;

function positionThumbPopover(anchor) {
  const rect = anchor.getBoundingClientRect();
  const pop = elements.thumbPopover;
  const size = pop.getBoundingClientRect();
  let left = rect.right + 10;
  if (left + size.width > window.innerWidth - 12) left = rect.left - size.width - 10;
  if (left < 12) left = Math.max(12, Math.min(rect.right + 10, window.innerWidth - size.width - 12));
  const top = Math.max(12, Math.min(rect.top + rect.height / 2 - size.height / 2, window.innerHeight - size.height - 12));
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function hideThumbPopover() {
  thumbHoverToken += 1;
  clearTimeout(thumbHoverTimer);
  elements.thumbPopover.classList.add('is-hidden');
}

async function showThumbPopover(file, anchor) {
  const token = ++thumbHoverToken;
  const reveal = (dataUrl) => {
    if (token !== thumbHoverToken) return;
    elements.thumbPopoverImage.onload = () => {
      if (token === thumbHoverToken) positionThumbPopover(anchor);
    };
    elements.thumbPopoverImage.src = dataUrl;
    elements.thumbPopover.classList.remove('is-hidden');
    positionThumbPopover(anchor);
  };
  const cached = thumbPreviewCache.get(file.path);
  if (cached) {
    reveal(cached);
    return;
  }
  try {
    const preview = await api.getImagePreview(file.path, 480);
    if (thumbPreviewCache.size >= 30) thumbPreviewCache.delete(thumbPreviewCache.keys().next().value);
    thumbPreviewCache.set(file.path, preview.dataUrl);
    reveal(preview.dataUrl);
  } catch {
    // 原图缺失或不可读时不显示气泡
  }
}

function bindThumbPopover(image, file) {
  image.addEventListener('mouseenter', () => {
    clearTimeout(thumbHoverTimer);
    thumbHoverTimer = setTimeout(() => showThumbPopover(file, image), 140);
  });
  image.addEventListener('mouseleave', hideThumbPopover);
}
elements.queueList.addEventListener('scroll', hideThumbPopover);

function makeQueueItem(file, index) {
  const row = document.createElement('article');
  row.className = `queue-item ${file.status ? `is-${file.status}` : ''}${file.selected === false ? ' is-unchecked' : ''}`;
  row.dataset.path = file.path;

  const check = document.createElement('input');
  check.className = 'queue-check-input';
  check.type = 'checkbox';
  check.checked = file.selected !== false;
  check.disabled = state.running;
  check.title = t('勾选后参与本次批处理');
  check.setAttribute('aria-label', t('选择 {name}', { name: file.name }));
  check.addEventListener('click', (event) => event.stopPropagation());
  check.addEventListener('change', () => {
    file.selected = check.checked;
    renderQueue();
  });

  const image = document.createElement('img');
  image.className = 'queue-thumb';
  image.src = file.thumbnail;
  image.alt = '';
  bindThumbPopover(image, file);

  const copy = document.createElement('div');
  copy.className = 'queue-copy';
  const name = document.createElement('span');
  name.className = 'queue-name';
  name.textContent = file.name;
  name.title = file.path;
  const meta = document.createElement('span');
  meta.className = 'queue-meta';
  meta.textContent = `${file.width} × ${file.height} · ${formatBytes(file.bytes)}`;
  copy.append(name, meta);
  // 采集来源小标记：直取原图（接口拦截，未加工）/ 降级裁切（加隔离带重发）/ 页面采集（无隔离带）
  if (file.status === 'complete' && file.timings?.totalMs) {
    const flag = document.createElement('span');
    flag.className = 'capture-flag is-page';
    flag.textContent = t('耗时 {n}秒', { n: (file.timings.totalMs / 1000).toFixed(1) });
    flag.title = t(file.timingSummary || '');
    copy.append(flag);
  }
    if (file.status === 'complete' && file.auditMode && file.auditMode !== 'manual-skip') {
    const flag = document.createElement('span');
    const usedFallback = file.auditMode === 'same-conversation-with-fallback';
    flag.className = usedFallback ? 'qc-flag' : 'capture-flag is-raw';
    flag.textContent = usedFallback ? t('复检：同会话→回退') : t('同会话复检');
    flag.title = usedFallback
      ? t('优先在当前会话复检；同会话失败后才重新上传结果图兜底')
      : t('直接检查当前会话上一张生成图，未重新上传结果图');
    copy.append(flag);
  }
    if (file.status === 'complete' && file.captureSource) {
    const flag = document.createElement('span');
    const isRaw = file.captureSource === 'api-raw';
    const isFallback = !isRaw && file.removedUploadPadding === true;
    flag.className = `capture-flag ${isRaw ? 'is-raw' : isFallback ? 'is-fallback' : 'is-page'}`;
    flag.textContent = isRaw ? t('直取原图') : isFallback ? t('降级裁切') : t('页面采集');
    flag.title = isRaw
      ? t('已从豆包接口直取无水印原图：未加隔离带、未裁切')
      : isFallback
        ? t('接口未拦截到无水印原图，已自动加隔离带重发并完成裁切')
        : t('接口未拦截到无水印原图，已使用页面生成结果（未加隔离带）');
    copy.append(flag);
  }
  if (file.status === 'complete' && file.overwriteStatus && file.overwriteStatus !== 'disabled') {
    const flag = document.createElement('span');
    if (file.overwriteStatus === 'overwritten') {
      flag.className = 'capture-flag is-raw';
      flag.textContent = t('已覆盖原图');
      flag.title = t('最终复检和像素质检均通过，已安全替换原文件');
    } else {
      flag.className = 'qc-flag';
      const overwriteLabels = {
        'manual-skip': ['未覆盖：手动重绘', '手动涂抹重绘不会自动覆盖原图，结果保留在输出目录'],
        'blocked-residual': ['未覆盖：复检未通过', '残留水印最终复检未通过，为保护原文件没有覆盖'],
        'blocked-qc': ['未覆盖：质检未通过', '最终像素质检未通过，为保护原文件没有覆盖'],
        'unsupported-format': ['未覆盖：格式限制', '当前原图格式无法安全保持原格式覆盖，结果保留在输出目录'],
        failed: ['未覆盖：替换失败', '安全替换原文件失败，原图保持不变，结果保留在输出目录']
      };
      const detail = overwriteLabels[file.overwriteStatus] || ['未覆盖原图', '原图保持不变'];
      flag.textContent = t(detail[0]);
      flag.title = t(detail[1]);
    }
    copy.append(flag);
  }
  if (file.status === 'complete' && ['review', 'residual-after-max', 'audit-failed', 'repair-failed'].includes(file.residualStatus)) {
    const flag = document.createElement('span');
    flag.className = 'qc-flag';
    if (file.residualStatus === 'residual-after-max') {
      flag.textContent = t('复检：仍有疑似残留');
      flag.title = t('自动定点补修已达到上限，仍检测到疑似残留；建议点击预览确认');
    } else if (file.residualStatus === 'review') {
      flag.textContent = t('复检：需人工确认');
      flag.title = t('检测到低置信度疑似标记，为避免误删真实场景文字，未自动处理');
    } else if (file.residualStatus === 'audit-failed') {
      flag.textContent = t('复检：未完成');
      flag.title = t('残留水印自动复检未完成，当前结果已保留');
    } else {
      flag.textContent = t('补修：未完成');
      flag.title = t('自动定点补修未完成，已保留上一版有效结果');
    }
    copy.append(flag);
  }
  if (file.status === 'complete' && file.qc && file.qc.verdict !== 'ok') {
    const flag = document.createElement('span');
    flag.className = 'qc-flag';
    const percent = (file.qc.changedRatio * 100).toFixed(1);
    flag.textContent = file.qc.verdict === 'unchanged' ? t('质检：疑似未处理') : t('质检：差异过大');
    flag.title = file.qc.verdict === 'unchanged'
      ? t('与原图相比变化像素仅 {p}%，疑似没有实际处理；点击"预览"查看差异热力图', { p: percent })
      : t('与原图相比变化像素达 {p}%，差异异常大；点击"预览"查看差异热力图', { p: percent });
    copy.append(flag);
  }

  const status = document.createElement('div');
  status.className = 'job-status';
  if (file.status === 'complete' && file.outputPath) {
    status.classList.add('result-actions');
    const regenerateButton = document.createElement('button');
    regenerateButton.className = 'result-action-button regenerate-result';
    regenerateButton.type = 'button';
    regenerateButton.disabled = Boolean(file.missing) || Boolean(file.regenRequested);
    regenerateButton.classList.toggle('is-pending', Boolean(file.regenRequested));
    regenerateButton.title = file.missing
      ? t('原图已移动或删除，无法重新生成')
      : file.regenRequested
        ? t('正在发起重新生成…')
        : t('重新生成（接回该图片的历史对话）');
    regenerateButton.setAttribute('aria-label', t('重新生成'));
    regenerateButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
    regenerateButton.addEventListener('click', () => regenerateFile(file));
    const previewButton = document.createElement('button');
    previewButton.className = 'result-action-button preview-result';
    previewButton.type = 'button';
    previewButton.textContent = t('预览');
    previewButton.addEventListener('click', () => openPreview(file));
    const manualButton = document.createElement('button');
    manualButton.className = 'result-action-button manual-result';
    manualButton.type = 'button';
    manualButton.textContent = t('涂抹重绘');
    manualButton.disabled = Boolean(file.missing);
    manualButton.title = file.missing ? t('原图已移动或删除，无法手动涂抹') : t('在原图上涂抹后重新发送');
    manualButton.addEventListener('click', () => openManualEditor(file));
    status.append(regenerateButton, previewButton, manualButton);
  } else {
    const statusTitle = document.createElement('strong');
    statusTitle.textContent = t(file.message || (file.selected === false && !file.status ? '本次跳过' : '等待处理'));
    statusTitle.title = statusTitle.textContent;
    const statusMeta = document.createElement('span');
    statusMeta.textContent = file.status === 'error'
      ? t('可以重新开始任务重试')
      : t('队列 #{index}', { index: String(index + 1).padStart(2, '0') });
    status.append(statusTitle, statusMeta);
  }

  const remove = document.createElement('button');
  remove.className = 'remove-button';
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = t('移除');
  remove.disabled = state.running;
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    state.files = state.files.filter((item) => item.path !== file.path);
    renderQueue();
  });

  row.append(check, image, copy, status, remove);
  if (file.status === 'active') {
    const progress = document.createElement('div');
    progress.className = 'task-progress';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    progress.setAttribute('aria-valuenow', String(file.progress || 5));
    const progressBar = document.createElement('span');
    progressBar.style.width = `${file.progress || 5}%`;
    progress.append(progressBar);
    row.append(progress);
  }
  return row;
}

function renderQueue() {
  hideThumbPopover();
  elements.queueList.replaceChildren(...state.files.map(makeQueueItem));
  syncActionState();
  scheduleQueueSave();
}

let queueSaveTimer;
function scheduleQueueSave(delay = 180) {
  if (!state.queueReady) return;
  clearTimeout(queueSaveTimer);
  queueSaveTimer = setTimeout(() => {
    api.saveQueueRecords(state.files).catch((error) => {
      console.error('保存队列记录失败', error);
    });
  }, delay);
}

async function persistQueueNow() {
  if (!state.queueReady) return;
  clearTimeout(queueSaveTimer);
  await api.saveQueueRecords(state.files);
}

async function addFiles(files) {
  const existing = new Set(state.files.map((file) => file.path));
  const additions = files.filter((file) => !existing.has(file.path));
  state.files.push(...additions.map((file) => ({ ...file, status: '', message: '', selected: true })));
  renderQueue();
  if (files.length && !additions.length) toast(t('这些图片已经在队列中'));
}

function updateLogin(status) {
  state.loggedIn = Boolean(status?.loggedIn);
  elements.loginPill.classList.toggle('is-online', state.loggedIn);
  elements.loginPill.classList.toggle('is-offline', !state.loggedIn);
  elements.loginText.textContent = state.loggedIn ? t('豆包已登录 · 状态已保存') : t('豆包未登录');
  elements.loginButtonText.textContent = state.loggedIn ? t('打开豆包') : t('登录豆包');
  elements.logoutButton.classList.toggle('is-hidden', !state.loggedIn);
  elements.logoutButton.disabled = state.running;
  syncActionState();
}

function setRunning(value) {
  state.running = value;
  elements.logoutButton.disabled = value;
  renderQueue();
}

function updateFile(path, patch) {
  const item = state.files.find((file) => file.path === path);
  if (!item) return;
  Object.assign(item, patch);
  renderQueue();
}

function handleBatchEvent(event) {
  if (event.type === 'batch-start') {
    const batchId = event.batchId || 'default';
    const firstBatch = state.activeBatches.size === 0;
    state.activeBatches.add(batchId);
    if (firstBatch) setRunning(true);
    if (event.parallel) toast(t('多线程模式已开启：{n} 张图片同时处理', { n: event.workers || 3 }));
    if (event.mode === 'manual' && event.path) {
      updateFile(event.path, { status: 'active', message: '准备局部重绘', progress: 5 });
    } else if (firstBatch) {
      state.files.forEach((file) => {
        if (file.selected === false) return;
        Object.assign(file, { status: '', message: '', progress: 0 });
      });
      renderQueue();
    }
  }
  if (event.type === 'job-start') {
    updateFile(event.path, {
      status: 'active',
      message: event.mode === 'manual' ? '准备局部重绘' : '准备处理',
      progress: 5,
      regenRequested: false
    });
  }
  if (event.type === 'job-progress') {
    const current = state.files.find((file) => file.path === event.path)?.progress || 5;
    updateFile(event.path, {
      status: 'active',
      message: event.message,
      progress: progressForMessage(event.message, current),
      qc: null
    });
  }
  if (event.type === 'verification-required') {
    toast(t('豆包触发了安全验证，已暂停任务并显示验证窗口，请手动完成'));
  }
  if (event.type === 'verification-cleared') {
    toast(t('安全验证已完成，正在重新开始被中断的任务'));
  }
  if (event.type === 'job-complete') {
    const source = state.files.find((file) => file.path === event.sourcePath);
    if (source) {
      Object.assign(source, {
        status: 'complete',
        message: '',
        selected: false,
        regenRequested: false,
        ...(event.conversationId ? { conversationId: event.conversationId } : {}),
        outputPath: event.outputPath,
        cropped: event.cropped,
        cropPercent: event.cropPercent,
        cropEdge: event.cropEdge,
        removedUploadPadding: event.removedUploadPadding,
        autoRepairPasses: event.autoRepairPasses || 0,
        residualAuditCount: event.residualAuditCount || 0,
        residualStatus: event.residualStatus || '',
        sameConversationAuditCount: event.sameConversationAuditCount || 0,
        auditFallbackCount: event.auditFallbackCount || 0,
        auditMode: event.auditMode || '',
        timings: event.timings || null,
        timingSummary: event.timingSummary || '',
        overwroteOriginal: event.overwroteOriginal === true,
        overwriteStatus: event.overwriteStatus || '',
        ...(event.refreshedSource ? {
          bytes: event.refreshedSource.bytes,
          width: event.refreshedSource.width,
          height: event.refreshedSource.height,
          thumbnail: event.refreshedSource.thumbnail
        } : {}),
        captureSource: event.captureSource || null,
        outputWidth: event.width,
        outputHeight: event.height,
        progress: 100
      });
      if (event.overwroteOriginal) thumbPreviewCache.delete(source.path);
      renderQueue();
      persistQueueNow().catch((error) => console.error('保存完成记录失败', error));
    }
  }
  if (event.type === 'job-qc' && event.qc) {
    const source = state.files.find((file) => file.path === event.path);
    if (source) {
      source.qc = {
        verdict: event.qc.verdict,
        changedRatio: event.qc.changedRatio,
        meanDiff: event.qc.meanDiff
      };
      renderQueue();
      persistQueueNow().catch((error) => console.error('保存质检记录失败', error));
      if (event.qc.verdict === 'unchanged') {
        toast(t('{name}：质检提示结果与原图几乎无差异，建议预览确认或重新生成', { name: event.name }), 'error');
      } else if (event.qc.verdict === 'different') {
        toast(t('{name}：质检提示结果与原图差异过大，请预览确认', { name: event.name }), 'error');
      }
    }
  }
  if (event.type === 'job-error') {
    const source = state.files.find((file) => file.path === event.path);
    updateFile(event.path, {
      status: event.mode === 'manual' && source?.outputPath ? 'complete' : 'error',
      message: event.mode === 'manual' && source?.outputPath ? '' : event.error,
      regenRequested: false,
      ...(event.conversationId ? { conversationId: event.conversationId } : {})
    });
    toast(t('{name}：{error}', { name: event.name, error: t(event.error) }), 'error');
  }
  if (event.type === 'batch-complete') {
    state.activeBatches.delete(event.batchId || 'default');
    const idle = state.activeBatches.size === 0;
    if (idle) setRunning(false);
    if (event.cancelled && idle) {
      state.files.forEach((file) => {
        if (file.status !== 'active') return;
        Object.assign(file, file.outputPath
          ? { status: 'complete', message: '', progress: 100 }
          : { status: '', message: '', progress: 0 });
      });
      renderQueue();
    }
    if (event.cancelled) toast(event.mode === 'manual' ? t('局部重绘已停止') : t('批处理已停止'));
    else if (event.failed) toast(event.mode === 'manual' ? t('局部重绘失败，请调整涂抹区域后重试') : t('处理结束：成功 {a} 张，失败 {b} 张', { a: event.completed, b: event.failed }), 'error');
    else toast(event.mode === 'manual' ? t('局部重绘完成，点击预览查看结果') : t('全部完成，共导出 {n} 张图片', { n: event.completed }));
  }
}

elements.loginButton.addEventListener('click', async () => {
  try {
    const result = await api.openLogin();
    if (!result?.alreadyLoggedIn) toast(t('已打开豆包登录界面，登录状态会自动保存'));
  } catch (error) {
    toast(t(error.message || String(error)), 'error');
  }
});

elements.logoutButton.addEventListener('click', async () => {
  elements.logoutButton.disabled = true;
  try {
    await api.logout();
    updateLogin({ loggedIn: false });
    toast(t('已退出豆包登录，并清除本工具保存的登录状态'));
  } catch (error) {
    toast(t(error.message || String(error)), 'error');
  } finally {
    elements.logoutButton.disabled = state.running;
  }
});

// 拖拽文件夹：递归遍历目录条目收集图片路径（readEntries 每批最多 100 条，需循环读到空）
const DROPPED_IMAGE_PATTERN = /\.(jpe?g|png|webp|bmp|gif|avif|heic|heif)$/i;
const MAX_DROP_PATHS = 300;

function readEntryFiles(entry, paths, depth) {
  return new Promise((resolve) => {
    if (paths.length >= MAX_DROP_PATHS) return resolve();
    if (entry.isFile) {
      entry.file((file) => {
        const filePath = api.pathForFile(file);
        if (filePath && DROPPED_IMAGE_PATTERN.test(filePath)) paths.push(filePath);
        resolve();
      }, () => resolve());
      return;
    }
    if (!entry.isDirectory || depth > 6) return resolve();
    const reader = entry.createReader();
    const readBatch = () => {
      reader.readEntries(async (children) => {
        if (!children.length) return resolve();
        for (const child of children) await readEntryFiles(child, paths, depth + 1);
        if (paths.length >= MAX_DROP_PATHS) return resolve();
        readBatch();
      }, () => resolve());
    };
    readBatch();
  });
}

async function collectDroppedPaths(dataTransfer) {
  const entries = [...(dataTransfer.items || [])]
    .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() : null))
    .filter(Boolean);
  if (!entries.length) {
    return [...dataTransfer.files].map((file) => api.pathForFile(file)).filter(Boolean);
  }
  const paths = [];
  for (const entry of entries) await readEntryFiles(entry, paths, 0);
  return paths;
}

elements.dropZone.addEventListener('click', async () => addFiles(await api.selectImages()));
elements.dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (!state.running) elements.dropZone.classList.add('is-over');
});
elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('is-over'));
elements.dropZone.addEventListener('drop', async (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove('is-over');
  if (state.running) return;
  const paths = await collectDroppedPaths(event.dataTransfer);
  if (!paths.length) {
    toast(t('拖入的内容里没有可处理的图片'), 'error');
    return;
  }
  if (paths.length >= MAX_DROP_PATHS) toast(t('图片较多，已先添加前 {n} 张', { n: MAX_DROP_PATHS }));
  addFiles(await api.validatePaths(paths));
});

// 剪贴板粘贴入队：截图/复制的图片直接 Cmd/Ctrl+V 进队列
// 剪贴板里是真实文件（如 Finder 中复制的图片）时优先用原路径，否则把字节落盘到收件箱
document.addEventListener('paste', async (event) => {
  if (state.running) return;
  if (event.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
  const imageItem = [...(event.clipboardData?.items || [])]
    .find((item) => item.kind === 'file' && item.type.startsWith('image/'));
  if (!imageItem) return;
  const blob = imageItem.getAsFile();
  if (!blob) return;
  event.preventDefault();
  try {
    const realPath = api.pathForFile(blob);
    if (realPath) {
      const valid = await api.validatePaths([realPath]);
      if (valid.length) {
        await addFiles(valid);
        return;
      }
    }
  } catch { /* 非真实文件，走落盘 */ }
  try {
    const file = await api.saveClipboardImage(await blob.arrayBuffer(), blob.type);
    if (file) {
      await addFiles([file]);
      toast(t('已从剪贴板添加图片'));
    } else {
      toast(t('剪贴板图片保存失败'), 'error');
    }
  } catch (error) {
    toast(t(error.message || String(error)), 'error');
  }
});

elements.clearButton.addEventListener('click', () => {
  state.files = [];
  renderQueue();
});

elements.selectAllCheckbox.addEventListener('change', () => {
  const checkAll = state.files.some((file) => file.selected === false);
  state.files.forEach((file) => { file.selected = checkAll; });
  renderQueue();
});

elements.overwriteOriginal.addEventListener('change', async () => {
  if (elements.overwriteOriginal.checked && !state.settings?.overwriteOriginalConfirmed) {
    const confirmed = window.confirm(t('开启“覆盖原图”后，只有通过最终残留复检和像素质检的处理结果才会替换原文件；处理失败、存在疑似残留或质检异常时不会覆盖。是否继续？'));
    if (!confirmed) {
      elements.overwriteOriginal.checked = false;
      return;
    }
    state.settings = { ...state.settings, overwriteOriginalConfirmed: true };
  }
  state.settings = await api.saveSettings(readSettings());
  applySettings(state.settings);
});
elements.showBrowserWindow.addEventListener('change', scheduleSettingsSave);
elements.intervalSeconds.addEventListener('change', scheduleSettingsSave);
elements.imageWaitSeconds.addEventListener('change', scheduleSettingsSave);
elements.maxConcurrentTasks.addEventListener('change', scheduleSettingsSave);
elements.parallelProcessing.addEventListener('change', () => {
  syncProcessingControls();
  scheduleSettingsSave();
});
elements.themeModeButtons.forEach((button) => button.addEventListener('click', async () => {
  state.settings = await api.saveSettings({ ...readSettings(), themeMode: button.dataset.themeMode });
  applySettings(state.settings);
}));
// 切换语言后整窗口重载：静态文案在加载时按语言就地替换，重载是最可靠的全量刷新方式
elements.languageButtons.forEach((button) => button.addEventListener('click', async () => {
  if ((state.settings?.language || 'zh') === button.dataset.language) return;
  await persistQueueNow().catch(() => {});
  state.settings = await api.saveSettings({ ...readSettings(), language: button.dataset.language });
  location.reload();
}));
elements.paletteButtons.forEach((button) => button.addEventListener('click', async () => {
  state.settings = await api.saveSettings({
    ...readSettings(),
    colorPalette: button.dataset.palette,
    themeColor: PRESET_COLORS[button.dataset.palette]
  });
  applySettings(state.settings);
}));
elements.themeColor.addEventListener('input', () => {
  state.settings = {
    ...state.settings,
    colorPalette: 'custom',
    themeColor: elements.themeColor.value
  };
  applyAppearance(state.settings);
  scheduleSettingsSave();
});
function setAppearancePopover(open) {
  elements.appearanceColors.classList.toggle('is-hidden', !open);
  elements.appearanceToggle.setAttribute('aria-expanded', String(open));
  elements.appearanceToggle.title = open ? t('收起颜色设置') : t('展开颜色设置');
}
elements.appearanceToggle.addEventListener('click', (event) => {
  event.stopPropagation();
  setAppearancePopover(elements.appearanceColors.classList.contains('is-hidden'));
});
document.addEventListener('click', (event) => {
  if (elements.appearanceColors.classList.contains('is-hidden')) return;
  if (event.target.closest('.appearance-popover-anchor')) return;
  setAppearancePopover(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.appearanceColors.classList.contains('is-hidden')) setAppearancePopover(false);
});
elements.advancedSettingsButton.addEventListener('click', () => api.openAdvancedSettings());
api.onSettingsUpdated((settings) => {
  applySettings(settings);
  toast(t('高级处理设置已保存'));
});

elements.outputButton.addEventListener('click', async () => {
  const selected = await api.chooseOutput(state.settings.outputDirectory);
  if (!selected) return;
  state.settings.outputDirectory = selected;
  elements.outputPath.textContent = selected;
  elements.outputPath.title = selected;
  state.settings = await api.saveSettings(readSettings());
});

elements.openOutputButton.addEventListener('click', () => api.openPath(state.settings.outputDirectory));
// 批量导出：只打包勾选的已完成图片（按钮也只在有勾选的已完成任务时可用）
elements.exportZipButton.addEventListener('click', async () => {
  const targets = state.files.filter((file) => file.status === 'complete' && file.outputPath && file.selected !== false);
  if (!targets.length) {
    toast(t('请先勾选要导出的已完成任务'));
    return;
  }
  elements.exportZipButton.disabled = true;
  try {
    const result = await api.exportZip(targets.map((file) => file.outputPath));
    if (result?.cancelled) return;
    if (result?.exported) {
      toast(t('已导出 {n} 张图片：{path}', { n: result.exported, path: result.zipPath }));
    } else {
      toast(t('没有可导出的图片'));
    }
  } catch (error) {
    toast(t(error.message || String(error)), 'error');
  } finally {
    syncActionState();
  }
});
elements.cancelButton.addEventListener('click', async () => {
  elements.cancelButton.disabled = true;
  elements.cancelButton.textContent = t('正在停止…');
  await api.cancelBatch();
  setTimeout(() => {
    elements.cancelButton.disabled = false;
    elements.cancelButton.textContent = t('停止任务');
  }, 1500);
});

elements.startButton.addEventListener('click', async () => {
  if (state.running) return;
  const items = state.files
    .filter((file) => file.selected !== false)
    .map((file) => ({ path: file.path, conversationId: file.conversationId || '' }));
  if (!items.length) return;
  // 立即切换为运行状态（显示「停止任务」），防止启动期间被当作没点到而重复点击
  setRunning(true);
  try {
    const settings = readSettings();
    state.settings = await api.saveSettings(settings);
    await api.startBatch({ paths: items, settings: state.settings });
  } catch (error) {
    if (state.activeBatches.size) renderQueue();
    else setRunning(false);
    toast(t(error.message || String(error)), 'error');
  }
});

api.onLoginStatus(updateLogin);
api.onBatchEvent(handleBatchEvent);
api.onManualSubmitted(handleManualSubmitted);
api.onAppEvent((event) => {
  if (event?.type === 'update-available') {
    toast(t('发现新版本 {v}，正在后台下载，完成后会提示重启', { v: event.version }));
  }
  if (event?.type === 'update-downloading') {
    toast(t('正在下载新版本 {v} 安装包，请稍候…', { v: event.version }));
  }
});

async function initialize() {
  const settings = await api.getSettings();
  window.wlI18n.init(settings.language);
  window.wlI18n.applyDom();
  applySettings(settings);
  state.files = (await api.getQueueRecords()).map((record) => ({
    ...record,
    selected: typeof record.selected === 'boolean' ? record.selected : record.status !== 'complete'
  }));
  state.queueReady = true;
  updateLogin(await api.getLoginStatus());
  renderQueue();
}

initialize().catch((error) => toast(t(error.message || String(error)), 'error'));
