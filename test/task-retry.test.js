'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_AUTO_RETRIES,
  exhaustedRetryMessage,
  isDestroyedObjectError,
  normalizeTaskError,
  retryProgressMessage,
  shouldAutoRetryTaskError
} = require('../src/task-retry');

test('Object has been destroyed 会被归一化为 WORKER_DESTROYED 并允许自动重跑', () => {
  const original = new Error('Object has been destroyed');
  const normalized = normalizeTaskError(original);
  assert.equal(normalized.code, 'WORKER_DESTROYED');
  assert.equal(isDestroyedObjectError(normalized), true);
  assert.equal(shouldAutoRetryTaskError(normalized), true);
  assert.match(retryProgressMessage(normalized, 1), /重新创建后自动重跑（1\/3）/);
});

test('常见页面和网络类失败默认允许自动重跑', () => {
  assert.equal(shouldAutoRetryTaskError(new Error('豆包页面响应超时，请刷新页面后重试')), true);
  assert.equal(shouldAutoRetryTaskError(new Error('没有找到豆包的图片上传控件')), true);
  assert.equal(shouldAutoRetryTaskError(new Error('等待豆包生成图片超时')), true);
});

test('源文件、权限和磁盘类确定性错误不会无意义重跑', () => {
  assert.equal(shouldAutoRetryTaskError(new Error('原图不存在或格式不受支持')), false);
  assert.equal(shouldAutoRetryTaskError(Object.assign(new Error('permission denied'), { code: 'EACCES' })), false);
  assert.equal(shouldAutoRetryTaskError(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })), false);
});

test('取消任务不会进入自动重跑', () => {
  const error = Object.assign(new Error('批处理已取消'), { code: 'CANCELLED' });
  assert.equal(shouldAutoRetryTaskError(error), false);
});

test('重跑上限固定为 3 次并生成最终停止提示', () => {
  assert.equal(MAX_AUTO_RETRIES, 3);
  assert.match(exhaustedRetryMessage(new Error('等待豆包生成图片超时')), /连续自动重跑 3 次仍失败，已停止/);
});
