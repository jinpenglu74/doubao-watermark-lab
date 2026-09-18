'use strict';

// 自动质检：对比原图与处理结果的逐像素差异，识别两类异常——
//   unchanged：差异过小，豆包大概率"假装处理了"（返回了原图或仅重编码）
//   different：差异过大，结果可能错图/毁图
// 本模块为纯函数，不依赖 Electron，便于单元测试；
// 主进程负责把两张图解码并缩放到相同尺寸后传入像素缓冲。

// 单通道差值超过该值视为"变化像素"（容忍 JPEG/重编码噪声 ±8 左右）
const CHANGED_THRESHOLD = 16;
// 变化像素占比 ≤ 0.3% → 疑似未处理（重编码噪声差值低于 CHANGED_THRESHOLD，不会计入占比）
const UNCHANGED_MAX_RATIO = 0.003;
// 大面积低强度变化可能是平铺/半透明水印被正确清除，不能只凭“变化面积大”判毁图。
// 只有大面积变化同时具备明显强度，或全局平均差异极高，才判定差异过大。
const DIFFERENT_MIN_RATIO = 0.85;
const DIFFERENT_RATIO_MIN_MEAN = 20;
const DIFFERENT_MIN_MEAN = 42;

/**
 * 逐像素比较两个相同尺寸的 4 通道像素缓冲（BGRA/RGBA 均可，两图格式一致即可）。
 * @param {Buffer|Uint8Array} bufferA
 * @param {Buffer|Uint8Array} bufferB
 * @returns {{ changedRatio: number, meanDiff: number }}
 *   changedRatio：变化像素占比 0..1；meanDiff：全体像素单通道最大差值的平均 0..255
 */
function computeDiffStats(bufferA, bufferB) {
  const length = Math.min(bufferA.length, bufferB.length);
  const pixelCount = Math.floor(length / 4);
  if (!pixelCount) return { changedRatio: 0, meanDiff: 0 };
  let changed = 0;
  let diffSum = 0;
  for (let offset = 0; offset < pixelCount * 4; offset += 4) {
    const d0 = Math.abs(bufferA[offset] - bufferB[offset]);
    const d1 = Math.abs(bufferA[offset + 1] - bufferB[offset + 1]);
    const d2 = Math.abs(bufferA[offset + 2] - bufferB[offset + 2]);
    const pixelDiff = Math.max(d0, d1, d2);
    diffSum += pixelDiff;
    if (pixelDiff > CHANGED_THRESHOLD) changed += 1;
  }
  return {
    changedRatio: changed / pixelCount,
    meanDiff: diffSum / pixelCount
  };
}

/**
 * 根据差异统计给出质检结论。
 * @returns {'unchanged'|'different'|'ok'}
 */
function verdictForStats({ changedRatio, meanDiff }) {
  if (changedRatio <= UNCHANGED_MAX_RATIO) return 'unchanged';
  if (meanDiff >= DIFFERENT_MIN_MEAN
    || (changedRatio >= DIFFERENT_MIN_RATIO && meanDiff >= DIFFERENT_RATIO_MIN_MEAN)) return 'different';
  return 'ok';
}

/**
 * 生成差异热力图（4 通道，A=255）：原图暗化 30% 为底，变化像素按差值强度叠加红色。
 * 通道顺序跟随输入缓冲（BGRA/RGBA 都行，红色写入第 3 通道位置由调用方约定）。
 * @param {Buffer|Uint8Array} bufferA 原图像素
 * @param {Buffer|Uint8Array} bufferB 结果像素
 * @param {number} width
 * @param {number} height
 * @param {number} redChannelIndex 红色在 4 通道中的下标（RGBA=0，BGRA=2）
 * @returns {Buffer}
 */
function buildHeatmap(bufferA, bufferB, width, height, redChannelIndex = 0) {
  const pixelCount = Math.max(0, Math.floor(width * height));
  const heatmap = Buffer.alloc(pixelCount * 4);
  for (let offset = 0; offset < pixelCount * 4; offset += 4) {
    const d0 = Math.abs(bufferA[offset] - bufferB[offset]);
    const d1 = Math.abs(bufferA[offset + 1] - bufferB[offset + 1]);
    const d2 = Math.abs(bufferA[offset + 2] - bufferB[offset + 2]);
    const pixelDiff = Math.max(d0, d1, d2);
    const base0 = Math.round(bufferA[offset] * 0.3);
    const base1 = Math.round(bufferA[offset + 1] * 0.3);
    const base2 = Math.round(bufferA[offset + 2] * 0.3);
    const heat = pixelDiff > CHANGED_THRESHOLD ? Math.min(255, 80 + pixelDiff) : 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const base = channel === 0 ? base0 : channel === 1 ? base1 : base2;
      heatmap[offset + channel] = channel === redChannelIndex ? Math.max(base, heat) : base;
    }
    heatmap[offset + 3] = 255;
  }
  return heatmap;
}

module.exports = {
  CHANGED_THRESHOLD,
  UNCHANGED_MAX_RATIO,
  DIFFERENT_MIN_RATIO,
  DIFFERENT_RATIO_MIN_MEAN,
  DIFFERENT_MIN_MEAN,
  computeDiffStats,
  verdictForStats,
  buildHeatmap
};
