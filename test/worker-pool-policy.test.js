'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CONVERSATION_IMAGE_LIMIT,
  CONVERSATION_MAX_AGE_MS,
  conversationRotationReason,
  dispatchSpacingMs,
  effectiveConcurrency,
  effectiveVerificationLevel,
  registerVerificationCleared,
  registerVerificationTrigger
} = require('../src/worker-pool-policy');

test('聊天默认最多处理 3 张图片', () => {
  const now = 1_000_000;
  assert.equal(CONVERSATION_IMAGE_LIMIT, 3);
  assert.equal(conversationRotationReason({ startedAt: now - 1_000, imageCount: 2 }, now), '');
  assert.equal(conversationRotationReason({ startedAt: now - 1_000, imageCount: 3 }, now), 'image-limit');
});

test('聊天最长使用 15 分钟', () => {
  const now = 2_000_000;
  assert.equal(CONVERSATION_MAX_AGE_MS, 15 * 60_000);
  assert.equal(conversationRotationReason({ startedAt: now - CONVERSATION_MAX_AGE_MS + 1, imageCount: 1 }, now), '');
  assert.equal(conversationRotationReason({ startedAt: now - CONVERSATION_MAX_AGE_MS, imageCount: 1 }, now), 'time-limit');
});

test('新 worker 或强制轮换会创建新聊天', () => {
  assert.equal(conversationRotationReason({}, 1_000), 'new-worker');
  assert.equal(conversationRotationReason({ startedAt: 500, imageCount: 1, forceRotate: true }, 1_000), 'forced');
});

test('验证越频繁，调度会逐步降并发并扩大错峰', () => {
  const now = 10_000_000;
  const first = registerVerificationTrigger({}, now);
  assert.equal(first.level, 1);
  assert.equal(effectiveConcurrency(3, first, now), 3);
  assert.equal(dispatchSpacingMs(first, now), 1500);

  const second = registerVerificationTrigger(first, now + 10_000);
  assert.equal(second.level, 2);
  assert.equal(effectiveConcurrency(3, second, now + 10_000), 2);
  assert.equal(dispatchSpacingMs(second, now + 10_000), 3000);

  const third = registerVerificationTrigger(second, now + 20_000);
  assert.equal(third.level, 3);
  assert.equal(effectiveConcurrency(3, third, now + 20_000), 1);
  assert.equal(dispatchSpacingMs(third, now + 20_000), 5000);
});

test('验证风险 10 分钟无新触发后自动恢复正常并发', () => {
  const now = 20_000_000;
  const risk = registerVerificationTrigger({}, now);
  const later = now + 10 * 60_000 + 1;
  assert.equal(effectiveVerificationLevel(risk, later), 0);
  assert.equal(effectiveConcurrency(3, risk, later), 3);
  assert.equal(dispatchSpacingMs(risk, later), 700);
});

test('验证完成后仍保留一段冷却期', () => {
  const now = 30_000_000;
  const risk = registerVerificationTrigger({}, now);
  const cleared = registerVerificationCleared(risk, now + 2_000);
  assert.ok(cleared.cooldownUntil >= now + 10_000);
});
