'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDiffStats, verdictForStats, buildHeatmap } = require('../src/qc-check');

function makeBuffer(pixels, fill = [100, 150, 200, 255]) {
  const buffer = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i += 1) buffer.set(fill, i * 4);
  return buffer;
}

test('完全相同的图像判定为疑似未处理（unchanged）', () => {
  const a = makeBuffer(4096);
  const b = makeBuffer(4096);
  const stats = computeDiffStats(a, b);
  assert.equal(stats.changedRatio, 0);
  assert.equal(stats.meanDiff, 0);
  assert.equal(verdictForStats(stats), 'unchanged');
});

test('低于阈值的轻微重编码噪声仍判定为 unchanged', () => {
  const a = makeBuffer(4096);
  const b = makeBuffer(4096);
  // 全图 ±8 的噪声（模拟重编码），不超过 CHANGED_THRESHOLD=16
  for (let i = 0; i < 4096 * 4; i += 4) {
    b[i] = a[i] + 8;
    b[i + 1] = a[i + 1] - 8;
  }
  const stats = computeDiffStats(a, b);
  assert.equal(verdictForStats(stats), 'unchanged');
});

test('局部区域变化（典型去水印）判定为 ok', () => {
  const a = makeBuffer(10000); // 100x100
  const b = makeBuffer(10000);
  // 改变 10x10 区域（1% 像素），差值 200
  for (let y = 40; y < 50; y += 1) {
    for (let x = 40; x < 50; x += 1) {
      const offset = (y * 100 + x) * 4;
      b[offset] = 255;
      b[offset + 1] = 0;
    }
  }
  const stats = computeDiffStats(a, b);
  assert.ok(Math.abs(stats.changedRatio - 0.01) < 1e-9);
  assert.equal(verdictForStats(stats), 'ok');
});

test('全图剧烈变化判定为差异过大（different）', () => {
  const a = makeBuffer(4096, [10, 10, 10, 255]);
  const b = makeBuffer(4096, [240, 220, 200, 255]);
  const stats = computeDiffStats(a, b);
  assert.equal(stats.changedRatio, 1);
  assert.equal(verdictForStats(stats), 'different');
});

test('热力图：未变化区域为暗化原图，变化区域红色通道增强', () => {
  const a = makeBuffer(4, [100, 100, 100, 255]);
  const b = makeBuffer(4, [100, 100, 100, 255]);
  b[4] = 255; // 第 2 个像素的通道 0 差值 155
  const heatmap = buildHeatmap(a, b, 2, 2, 0); // RGBA：红在下标 0
  // 未变化像素：暗化 30%
  assert.deepEqual([...heatmap.subarray(0, 4)], [30, 30, 30, 255]);
  // 变化像素：红通道 = max(30, 80+155=235)，其余通道保持暗化
  assert.deepEqual([...heatmap.subarray(4, 8)], [235, 30, 30, 255]);
  // BGRA 时红色在下标 2
  const heatmapBgra = buildHeatmap(a, b, 2, 2, 2);
  assert.deepEqual([...heatmapBgra.subarray(4, 8)], [30, 30, 235, 255]);
});


test('大面积低强度变化可视为平铺或半透明水印清理，不误判毁图', () => {
  const a = makeBuffer(10000, [100, 100, 100, 255]);
  const b = makeBuffer(10000, [100, 100, 100, 255]);
  for (let i = 0; i < 9000; i += 1) {
    const offset = i * 4;
    b[offset] = 118;
    b[offset + 1] = 118;
    b[offset + 2] = 118;
  }
  const stats = computeDiffStats(a, b);
  assert.ok(stats.changedRatio > 0.85);
  assert.ok(stats.meanDiff < 20);
  assert.equal(verdictForStats(stats), 'ok');
});
