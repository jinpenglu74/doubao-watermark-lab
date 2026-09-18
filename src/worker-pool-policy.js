'use strict';

const CONVERSATION_IMAGE_LIMIT = 3;
const CONVERSATION_MAX_AGE_MS = 15 * 60_000;
const VERIFICATION_RISK_WINDOW_MS = 10 * 60_000;

function conversationRotationReason(state = {}, now = Date.now()) {
  if (state.forceRotate) return 'forced';
  const imageCount = Math.max(0, Number(state.imageCount) || 0);
  const startedAt = Math.max(0, Number(state.startedAt) || 0);
  if (!startedAt) return 'new-worker';
  if (imageCount >= CONVERSATION_IMAGE_LIMIT) return 'image-limit';
  if (now - startedAt >= CONVERSATION_MAX_AGE_MS) return 'time-limit';
  return '';
}

function effectiveVerificationLevel(state = {}, now = Date.now()) {
  const lastTriggeredAt = Math.max(0, Number(state.lastTriggeredAt) || 0);
  if (!lastTriggeredAt || now - lastTriggeredAt > VERIFICATION_RISK_WINDOW_MS) return 0;
  return Math.min(3, Math.max(0, Math.round(Number(state.level) || 0)));
}

function registerVerificationTrigger(state = {}, now = Date.now()) {
  const previousLevel = effectiveVerificationLevel(state, now);
  const level = Math.min(3, previousLevel + 1);
  const cooldownMs = level === 1 ? 15_000 : level === 2 ? 30_000 : 60_000;
  return {
    level,
    lastTriggeredAt: now,
    cooldownUntil: Math.max(Number(state.cooldownUntil) || 0, now + cooldownMs)
  };
}

function registerVerificationCleared(state = {}, now = Date.now()) {
  const level = effectiveVerificationLevel(state, now);
  const cooldownMs = level >= 3 ? 30_000 : level === 2 ? 15_000 : 8_000;
  return {
    ...state,
    level,
    cooldownUntil: Math.max(Number(state.cooldownUntil) || 0, now + cooldownMs)
  };
}

function effectiveConcurrency(maxConcurrent, state = {}, now = Date.now()) {
  const max = Math.max(1, Math.round(Number(maxConcurrent) || 1));
  const level = effectiveVerificationLevel(state, now);
  if (level >= 3) return 1;
  if (level >= 2) return Math.min(2, max);
  return max;
}

function dispatchSpacingMs(state = {}, now = Date.now()) {
  const level = effectiveVerificationLevel(state, now);
  if (level >= 3) return 5_000;
  if (level === 2) return 3_000;
  if (level === 1) return 1_500;
  return 700;
}

module.exports = {
  CONVERSATION_IMAGE_LIMIT,
  CONVERSATION_MAX_AGE_MS,
  VERIFICATION_RISK_WINDOW_MS,
  conversationRotationReason,
  dispatchSpacingMs,
  effectiveConcurrency,
  effectiveVerificationLevel,
  registerVerificationCleared,
  registerVerificationTrigger
};
