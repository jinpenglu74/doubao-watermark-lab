'use strict';

// 安全验证后整任务重启的自动化层测试：
// 利用 runInPage 会把页面函数序列化后交给 webContents.executeJavaScript 的特点，
// 用假 webContents 按函数名分发预设的页面状态，在 Node 里模拟整个等待流程。
const test = require('node:test');
const assert = require('node:assert/strict');
const { DoubaoAutomation } = require('../src/doubao-automation');

const GENERATED_IMAGE = {
  url: 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/result.jpeg~tplv-a9rns2rl98-downsize_watermark.png',
  width: 1024,
  height: 1024,
  displayWidth: 512,
  displayHeight: 512,
  pending: false,
  baseline: false,
  userMessage: false,
  alt: '',
  generatedContainer: true
};

function createHarness({ verificationPlan, snapshotPlan, shouldRestart }) {
  const state = { verificationChecks: 0, snapshotCalls: 0 };
  const progress = [];
  const webContents = {
    session: {},
    async executeJavaScript(source) {
      if (source.includes('pageVerificationState')) {
        state.verificationChecks += 1;
        return verificationPlan(state);
      }
      if (source.includes('pageImageSnapshot')) {
        state.snapshotCalls += 1;
        return snapshotPlan(state);
      }
      throw new Error(`未预期的页面调用: ${source.slice(0, 120)}`);
    }
  };
  const windowStub = {
    webContents,
    isVisible: () => true,
    isMinimized: () => false,
    isDestroyed: () => false,
    show() {},
    moveTop() {},
    focus() {},
    restore() {},
    hide() {}
  };
  const automation = new DoubaoAutomation(windowStub, {
    isCancelled: () => false,
    shouldRestart: shouldRestart || (() => false),
    onProgress: (message) => progress.push(message)
  });
  const capture = { candidates: new Map(), stop() {} };
  return { automation, capture, state, progress };
}

// 验证只出现一次（进入 waitForVerificationIfNeeded 时检测到，轮询时已消失）
const verificationOnce = (state) => ({ detected: state.verificationChecks === 1 });
const noVerification = () => ({ detected: false });

test('手动完成安全验证后：抛出 VERIFICATION_INTERRUPTED 让调度方整任务重启', async () => {
  const harness = createHarness({
    verificationPlan: verificationOnce,
    snapshotPlan: () => {
      throw new Error('验证完成后不应再读取页面快照');
    }
  });
  await assert.rejects(
    harness.automation.waitForGeneratedImage(new Set(), harness.capture, 30_000, {}),
    (error) => {
      assert.equal(error.code, 'VERIFICATION_INTERRUPTED');
      return true;
    }
  );
  assert.ok(harness.progress.some((message) => message.includes('正在重新开始任务')));
});

test('同批其他任务完成验证后：本任务收到重启信号立即中断等待', async () => {
  const harness = createHarness({
    verificationPlan: noVerification,
    // 模拟页面还在正常生成中，但批次信号要求整任务重启
    snapshotPlan: () => ({
      images: [],
      generating: true,
      finishedReplies: 0,
      followUps: 0,
      tailText: '正在生成',
      assistantTailText: ''
    })
  });
  // 调度方在批次信号变化后让 shouldRestart 返回 true（这里等两轮轮询模拟信号迟来）
  harness.automation.shouldRestart = () => harness.state.snapshotCalls >= 2;
  const startedAt = Date.now();
  await assert.rejects(
    harness.automation.waitForGeneratedImage(new Set(), harness.capture, 120_000, {}),
    (error) => {
      assert.equal(error.code, 'VERIFICATION_INTERRUPTED');
      return true;
    }
  );
  // 两个轮询周期内就该中断，而不是等到超时
  assert.ok(Date.now() - startedAt < 15_000, '重启信号应及时中断等待');
});

test('跟随者验证等待：不弹出自己的窗口，收到领头完成信号后立即中断重跑', async () => {
  const state = { verificationChecks: 0, shown: 0 };
  const progress = [];
  const webContents = {
    session: {},
    async executeJavaScript(source) {
      if (source.includes('pageVerificationState')) {
        state.verificationChecks += 1;
        return { detected: true };
      }
      throw new Error(`未预期的页面调用: ${source.slice(0, 120)}`);
    }
  };
  const windowStub = {
    webContents,
    isVisible: () => false,
    isMinimized: () => false,
    isDestroyed: () => false,
    show() { state.shown += 1; },
    moveTop() { state.shown += 1; },
    focus() {},
    restore() {},
    hide() {}
  };
  const automation = new DoubaoAutomation(windowStub, {
    isCancelled: () => false,
    // 模拟领头任务完成验证后广播的重启信号（首轮轮询后生效）
    shouldRestart: () => state.verificationChecks >= 2,
    onProgress: (message) => progress.push(message),
    // 调度方判定已有其他窗口在验证：本任务是跟随者
    onVerificationRequired: () => false,
    onVerificationCleared: () => {
      throw new Error('跟随者不应触发验证完成回调');
    }
  });
  const startedAt = Date.now();
  await assert.rejects(
    automation.waitForVerificationIfNeeded(60_000),
    (error) => {
      assert.equal(error.code, 'VERIFICATION_INTERRUPTED');
      return true;
    }
  );
  assert.equal(state.shown, 0, '跟随者不应弹出自己的窗口');
  assert.ok(progress.some((message) => message.includes('另一个窗口正在验证')));
  assert.ok(Date.now() - startedAt < 15_000, '重启信号应及时中断等待');
});

test('图形验证消失后又弹出手机号验证：不提前判定完成，继续等待', async () => {
  const state = { verificationChecks: 0, cleared: 0 };
  const webContents = {
    session: {},
    async executeJavaScript(source) {
      if (source.includes('pageVerificationState')) {
        state.verificationChecks += 1;
        // 第 1 轮：图形验证中；第 2 轮：过渡瞬间（未检出）；
        // 第 3 轮起：手机号验证出现（确认轮里检出，不能算完成）；第 6 轮起：全部完成
        if (state.verificationChecks === 2) return { detected: false };
        return { detected: state.verificationChecks < 6 };
      }
      throw new Error(`未预期的页面调用: ${source.slice(0, 120)}`);
    }
  };
  const windowStub = {
    webContents,
    isVisible: () => true,
    isMinimized: () => false,
    isDestroyed: () => false,
    show() {},
    moveTop() {},
    focus() {},
    restore() {},
    hide() {}
  };
  const automation = new DoubaoAutomation(windowStub, {
    isCancelled: () => false,
    shouldRestart: () => false,
    onProgress: () => {},
    onVerificationCleared: () => { state.cleared += 1; }
  });
  await assert.rejects(
    automation.waitForVerificationIfNeeded(120_000),
    (error) => {
      assert.equal(error.code, 'VERIFICATION_INTERRUPTED');
      return true;
    }
  );
  // 过渡瞬间（第 2 轮未检出）不应触发完成回调；只有第 6 轮起持续干净后才算完成
  assert.equal(state.cleared, 1);
  assert.ok(state.verificationChecks >= 9, '完成前应有连续多轮确认');
});

test('无验证、无重启信号时：图片生成完成后约 1 秒内结束等待', async () => {
  const harness = createHarness({
    verificationPlan: noVerification,
    snapshotPlan: () => ({
      images: [GENERATED_IMAGE],
      generating: false,
      finishedReplies: 0,
      followUps: 0,
      tailText: '图片已生成',
      assistantTailText: '图片已生成'
    })
  });
  const started = Date.now();
  const result = await harness.automation.waitForGeneratedImage(new Set(), harness.capture, 60_000, {});
  assert.ok(result.some((item) => item.url === GENERATED_IMAGE.url));
  assert.ok(Date.now() - started < 4_000, '图片已完成后不应再硬等 5~7 秒');
  assert.ok(harness.progress.some((message) => message.includes('立即进入残留复检')));
});


test('登录恢复 epoch 更新时：正在运行的任务立即抛出 LOGIN_RECOVERED_RESTART 重新开始', async () => {
  const harness = createHarness({
    verificationPlan: noVerification,
    snapshotPlan: () => ({
      images: [],
      generating: true,
      finishedReplies: 0,
      followUps: 0,
      tailText: '正在生成',
      assistantTailText: ''
    }),
    shouldRestart: () => 'login'
  });
  await assert.rejects(
    harness.automation.waitForGeneratedImage(new Set(), harness.capture, 60_000, {}),
    (error) => {
      assert.equal(error.code, 'LOGIN_RECOVERED_RESTART');
      assert.match(error.message, /登录会话已恢复/);
      return true;
    }
  );
});
