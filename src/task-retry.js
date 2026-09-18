'use strict';

const MAX_AUTO_RETRIES = 3;

function errorMessage(error) {
  return String(error?.message || error || '');
}

function isDestroyedObjectError(error) {
  const code = String(error?.code || '');
  const message = errorMessage(error);
  return code === 'WORKER_DESTROYED'
    || /object has been destroyed/i.test(message)
    || /webcontents?.*(?:destroyed|disposed)/i.test(message)
    || /render(?:er)? frame.*(?:disposed|destroyed)/i.test(message)
    || /browserwindow.*destroyed/i.test(message)
    || /豆包工作窗口已失效/.test(message)
    || /cannot call.*destroyed/i.test(message);
}

function workerDestroyedError(error) {
  const normalized = new Error('豆包工作窗口已失效');
  normalized.code = 'WORKER_DESTROYED';
  normalized.originalMessage = errorMessage(error);
  if (error?.stack) normalized.stack += `\nCaused by: ${error.stack}`;
  return normalized;
}

function normalizeTaskError(error) {
  if (isDestroyedObjectError(error)) return workerDestroyedError(error);
  return error instanceof Error ? error : new Error(errorMessage(error));
}

const NON_RETRYABLE_CODES = new Set([
  'CANCELLED',
  'SOURCE_MISSING',
  'SOURCE_INVALID',
  'UNSUPPORTED_SOURCE_FORMAT',
  'UNSUPPORTED_ORIGINAL_FORMAT',
  'OUTPUT_PERMISSION_DENIED',
  'DISK_FULL',
  'INVALID_INPUT'
]);

const NON_RETRYABLE_PATTERNS = [
  /原图(?:不存在|文件已移动或删除|格式不受支持|无法读取)/,
  /文件(?:已移动或删除|不存在)/,
  /格式不受支持/,
  /invalid source/i,
  /unsupported (?:source|file) format/i,
  /permission denied/i,
  /access is denied/i,
  /磁盘空间不足/,
  /no space left on device/i,
  /ENOSPC/i,
  /EACCES/i,
  /EPERM/i
];

function shouldAutoRetryTaskError(error) {
  const normalized = normalizeTaskError(error);
  if (NON_RETRYABLE_CODES.has(String(normalized?.code || ''))) return false;
  const message = errorMessage(normalized);
  if (NON_RETRYABLE_PATTERNS.some((pattern) => pattern.test(message))) return false;
  return true;
}

function retryProgressMessage(error, retryNumber, maxRetries = MAX_AUTO_RETRIES) {
  const normalized = normalizeTaskError(error);
  if (isDestroyedObjectError(normalized)) {
    return `豆包工作窗口异常，正在重新创建后自动重跑（${retryNumber}/${maxRetries}）`;
  }
  const summary = errorMessage(normalized).replace(/\s+/g, ' ').trim().slice(0, 120);
  return summary
    ? `任务失败，正在自动重跑（${retryNumber}/${maxRetries}）：${summary}`
    : `任务失败，正在自动重跑（${retryNumber}/${maxRetries}）`;
}

function exhaustedRetryMessage(error, maxRetries = MAX_AUTO_RETRIES) {
  const normalized = normalizeTaskError(error);
  const summary = errorMessage(normalized).replace(/\s+/g, ' ').trim().slice(0, 180);
  return summary
    ? `连续自动重跑 ${maxRetries} 次仍失败，已停止：${summary}`
    : `连续自动重跑 ${maxRetries} 次仍失败，已停止`;
}

module.exports = {
  MAX_AUTO_RETRIES,
  errorMessage,
  exhaustedRetryMessage,
  isDestroyedObjectError,
  normalizeTaskError,
  retryProgressMessage,
  shouldAutoRetryTaskError,
  workerDestroyedError
};
