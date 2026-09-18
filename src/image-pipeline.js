'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { expandUrlCandidates, looksLikeStaticAsset } = require('./url-candidates');

const MIME_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/avif', '.avif']
]);

function headerValue(headers, name) {
  return headers.get(name) || '';
}

function sniffContentType(buffer, fallback = '') {
  if (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(4, 12).toString('ascii').includes('ftypavif')) return 'image/avif';
  return fallback || 'image/png';
}

async function fetchWithTimeout(electronSession, url, timeoutMs = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await electronSession.fetch(url, {
      method: 'GET',
      credentials: 'include',
      referrer: 'https://www.doubao.com/',
      signal: controller.signal,
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function scoreImage(item, preferOriginal) {
  const area = item.width * item.height;
  let score = area;
  // 接口直取的无水印原图永远优先：它是服务端返回的未经页面压缩的原始生成结果
  if (item.source === 'api-raw') score += area * 2;
  if (item.source === 'dom') score += area * 0.18;
  if (preferOriginal && item.likelyOriginal) score += area * 0.45;
  if (item.kind === 'processed') score -= area * 0.12;
  score += Math.min(item.buffer.length, 8_000_000) / 8;
  return score;
}

async function downloadBestImage({
  candidates,
  electronSession,
  nativeImage,
  preferOriginal = true,
  onProgress = () => {}
}) {
  const variants = expandUrlCandidates(candidates)
    .filter((item) => !looksLikeStaticAsset(item.url))
    .slice(0, 36);

  if (!variants.length) {
    throw new Error('没有从豆包页面中发现可下载的图片资源');
  }

  const downloaded = [];
  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    onProgress(`正在验证图片资源 ${index + 1}/${variants.length}`);
    try {
      const response = await fetchWithTimeout(electronSession, variant.url);
      if (!response.ok) continue;

      const headerContentType = headerValue(response.headers, 'content-type').split(';')[0].toLowerCase();
      if (headerContentType && !headerContentType.startsWith('image/')) continue;
      const declaredLength = Number(headerValue(response.headers, 'content-length')) || 0;
      if (declaredLength && (declaredLength < 20_000 || declaredLength > 80_000_000)) continue;

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength < 20_000 || arrayBuffer.byteLength > 80_000_000) continue;
      const buffer = Buffer.from(arrayBuffer);
      const contentType = sniffContentType(buffer, headerContentType);
      const decoded = nativeImage.createFromBuffer(buffer);
      if (decoded.isEmpty()) continue;
      const { width, height } = decoded.getSize();
      if (width < 480 || height < 320 || width * height < 250_000) continue;

      const item = {
        ...variant,
        buffer,
        image: decoded,
        width,
        height,
        contentType
      };
      item.score = scoreImage(item, preferOriginal);
      downloaded.push(item);
    } catch {
      // Signed or transformed image URLs often have invalid alternatives. Keep trying.
    }
  }

  downloaded.sort((a, b) => b.score - a.score);
  if (!downloaded.length) {
    throw new Error('发现了图片链接，但无法下载有效的大图；请在豆包窗口确认图片已经生成完成');
  }
  return downloaded[0];
}

function shouldCrop(settings, candidate) {
  if (settings.cropMode === 'always') return true;
  if (settings.cropMode === 'never') return false;
  return !candidate.likelyOriginal;
}

async function isExactSourceImage(candidate, sourcePath) {
  if (!candidate?.buffer || !Buffer.isBuffer(candidate.buffer) || !sourcePath) return false;
  try {
    const sourceBuffer = await fs.readFile(sourcePath);
    return sourceBuffer.length === candidate.buffer.length && sourceBuffer.equals(candidate.buffer);
  } catch {
    return false;
  }
}

function safeStem(filePath) {
  return path.basename(filePath, path.extname(filePath))
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .slice(0, 120) || 'image';
}

function cropRectangle(width, height, percent, edge = 'top') {
  const croppedHeight = Math.max(1, Math.round(height * (1 - percent / 100)));
  return {
    x: 0,
    y: edge === 'bottom' ? 0 : Math.max(0, height - croppedHeight),
    width,
    height: croppedHeight
  };
}

function paddingPixelsForPercent(height, percent) {
  const normalized = Math.min(25, Math.max(1, Number(percent) || 10));
  return Math.max(1, Math.round(height * normalized / (100 - normalized)));
}

function restoreOriginalAspectRectangle(
  width,
  height,
  originalWidth,
  originalHeight,
  edge = 'top',
  compensationPercent = 0
) {
  const safeOriginalWidth = Math.max(1, Number(originalWidth) || width);
  const safeOriginalHeight = Math.max(1, Number(originalHeight) || height);
  const baseRestoredHeight = Math.min(
    height,
    Math.max(1, Math.round(width * safeOriginalHeight / safeOriginalWidth))
  );
  const normalizedCompensation = Math.min(3, Math.max(0, Number(compensationPercent) || 0));
  const compensationPixels = Math.min(
    baseRestoredHeight - 1,
    Math.max(0, Math.round(baseRestoredHeight * normalizedCompensation / 100))
  );
  const restoredHeight = Math.max(1, baseRestoredHeight - compensationPixels);
  const restoredWidth = Math.min(
    width,
    Math.max(1, Math.round(restoredHeight * safeOriginalWidth / safeOriginalHeight))
  );
  return {
    x: Math.max(0, Math.floor((width - restoredWidth) / 2)),
    y: edge === 'bottom' ? 0 : Math.max(0, height - baseRestoredHeight + compensationPixels),
    width: restoredWidth,
    height: restoredHeight
  };
}

function paintManualMaskOnBitmap(bitmap, width, height, strokes, brushPercent = 3) {
  if (!Buffer.isBuffer(bitmap) || bitmap.length !== width * height * 4) {
    throw new Error('原图像素格式不受支持，无法生成涂抹标记');
  }
  const normalizedStrokes = (Array.isArray(strokes) ? strokes : [])
    .slice(0, 120)
    .map((stroke) => (Array.isArray(stroke) ? stroke : [])
      .slice(0, 1200)
      .map((point) => ({
        x: Math.min(1, Math.max(0, Number(point?.x) || 0)),
        y: Math.min(1, Math.max(0, Number(point?.y) || 0))
      })))
    .filter((stroke) => stroke.length > 0);
  if (!normalizedStrokes.length) throw new Error('请先在原图上涂抹需要处理的区域');

  const output = Buffer.from(bitmap);
  const radius = Math.max(2, Math.round(Math.min(width, height) * Math.min(12, Math.max(0.5, Number(brushPercent) || 3)) / 200));
  const marker = { blue: 143, green: 45, red: 255 };
  const opacity = 0.58;

  const paintCircle = (centerX, centerY) => {
    const startX = Math.max(0, Math.floor(centerX - radius));
    const endX = Math.min(width - 1, Math.ceil(centerX + radius));
    const startY = Math.max(0, Math.floor(centerY - radius));
    const endY = Math.min(height - 1, Math.ceil(centerY + radius));
    const featherStart = radius * 0.82;
    for (let y = startY; y <= endY; y += 1) {
      for (let x = startX; x <= endX; x += 1) {
        const distance = Math.hypot(x - centerX, y - centerY);
        if (distance > radius) continue;
        const feather = distance <= featherStart ? 1 : (radius - distance) / Math.max(1, radius - featherStart);
        const alpha = opacity * feather;
        const offset = (y * width + x) * 4;
        output[offset] = Math.round(output[offset] * (1 - alpha) + marker.blue * alpha);
        output[offset + 1] = Math.round(output[offset + 1] * (1 - alpha) + marker.green * alpha);
        output[offset + 2] = Math.round(output[offset + 2] * (1 - alpha) + marker.red * alpha);
      }
    }
  };

  for (const stroke of normalizedStrokes) {
    let previous = {
      x: stroke[0].x * (width - 1),
      y: stroke[0].y * (height - 1)
    };
    paintCircle(previous.x, previous.y);
    for (const point of stroke.slice(1)) {
      const current = { x: point.x * (width - 1), y: point.y * (height - 1) };
      const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
      const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.45)));
      for (let step = 1; step <= steps; step += 1) {
        const ratio = step / steps;
        paintCircle(
          previous.x + (current.x - previous.x) * ratio,
          previous.y + (current.y - previous.y) * ratio
        );
      }
      previous = current;
    }
  }
  return output;
}

function watermarkRegionsToStrokes(regions, options = {}) {
  const brushPercent = Math.min(8, Math.max(1.5, Number(options.brushPercent) || 3));
  const normalized = (Array.isArray(regions) ? regions : [])
    .slice(0, 48)
    .map((region) => ({
      x: Math.min(1, Math.max(0, Number(region?.x) || 0)),
      y: Math.min(1, Math.max(0, Number(region?.y) || 0)),
      w: Math.min(1, Math.max(0, Number(region?.w) || 0)),
      h: Math.min(1, Math.max(0, Number(region?.h) || 0))
    }))
    .filter((region) => region.w > 0.001 && region.h > 0.001);

  const strokes = [];
  for (const region of normalized) {
    const margin = Math.min(0.04, Math.max(0.008, Math.max(region.w, region.h) * 0.12));
    const left = Math.max(0, region.x - margin);
    const top = Math.max(0, region.y - margin);
    const right = Math.min(1, region.x + region.w + margin);
    const bottom = Math.min(1, region.y + region.h + margin);
    const step = Math.max(0.008, Math.min(0.025, brushPercent / 180));
    const stroke = [];
    let row = 0;
    for (let y = top; y <= bottom + 0.0001; y += step) {
      const clampedY = Math.min(bottom, y);
      if (row % 2 === 0) {
        stroke.push({ x: left, y: clampedY }, { x: right, y: clampedY });
      } else {
        stroke.push({ x: right, y: clampedY }, { x: left, y: clampedY });
      }
      row += 1;
      if (clampedY >= bottom) break;
    }
    if (stroke.length < 2) {
      const centerY = Math.min(1, Math.max(0, (top + bottom) / 2));
      stroke.push({ x: left, y: centerY }, { x: right, y: centerY });
    }
    strokes.push(stroke);
  }
  return strokes.slice(0, 120);
}

async function prepareManualMarkedUpload({
  sourcePath,
  nativeImage,
  temporaryDirectory,
  strokes,
  brushPercent
}) {
  const sourceBuffer = await fs.readFile(sourcePath);
  let sourceImage = nativeImage.createFromBuffer(sourceBuffer);
  if (sourceImage.isEmpty() && typeof nativeImage.createFromPath === 'function') {
    sourceImage = nativeImage.createFromPath(sourcePath);
  }
  if (sourceImage.isEmpty()) throw new Error('无法读取原图，不能生成涂抹标记');
  const { width, height } = sourceImage.getSize();
  const markedBitmap = paintManualMaskOnBitmap(sourceImage.toBitmap(), width, height, strokes, brushPercent);
  const markedImage = nativeImage.createFromBitmap(markedBitmap, { width, height });
  if (markedImage.isEmpty()) throw new Error('涂抹标记图生成失败');

  let directory;
  try {
    directory = await fs.mkdtemp(path.join(temporaryDirectory, 'watermark-lab-manual-'));
    const uploadPath = path.join(directory, `${safeStem(sourcePath)}_manual-mark.png`);
    await fs.writeFile(uploadPath, markedImage.toPNG());
    return { path: uploadPath, directory, width, height };
  } catch (error) {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function preparePaddedUpload({
  sourcePath,
  nativeImage,
  temporaryDirectory,
  percent,
  edge = 'top'
}) {
  const sourceBuffer = await fs.readFile(sourcePath);
  let sourceImage = nativeImage.createFromBuffer(sourceBuffer);
  if (sourceImage.isEmpty() && typeof nativeImage.createFromPath === 'function') {
    sourceImage = nativeImage.createFromPath(sourcePath);
  }
  if (sourceImage.isEmpty()) throw new Error('无法读取原图，不能添加临时空白带');

  const { width, height } = sourceImage.getSize();
  const sourceBitmap = sourceImage.toBitmap();
  const rowBytes = width * 4;
  const expectedBytes = rowBytes * height;
  if (sourceBitmap.length !== expectedBytes) {
    throw new Error('原图像素格式不受支持，不能添加临时空白带');
  }

  const paddingPixels = paddingPixelsForPercent(height, percent);
  const paddedHeight = height + paddingPixels;
  const paddedBitmap = Buffer.alloc(rowBytes * paddedHeight, 0xff);
  const offset = edge === 'bottom' ? 0 : rowBytes * paddingPixels;
  sourceBitmap.copy(paddedBitmap, offset);

  const paddedImage = nativeImage.createFromBitmap(paddedBitmap, { width, height: paddedHeight });
  if (paddedImage.isEmpty()) throw new Error('临时空白带图片创建失败');

  let directory;
  try {
    directory = await fs.mkdtemp(path.join(temporaryDirectory, 'watermark-lab-upload-'));
    const uploadPath = path.join(directory, `${safeStem(sourcePath)}_padded.png`);
    await fs.writeFile(uploadPath, paddedImage.toPNG());
    return {
      path: uploadPath,
      directory,
      edge: edge === 'bottom' ? 'bottom' : 'top',
      originalWidth: width,
      originalHeight: height,
      paddedWidth: width,
      paddedHeight,
      paddingPixels,
      paddingPercent: Math.round(paddingPixels / paddedHeight * 1000) / 10
    };
  } catch (error) {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function uniquePath(directory, stem, extension) {
  let attempt = path.join(directory, `${stem}${extension}`);
  let counter = 2;
  while (true) {
    try {
      await fs.access(attempt);
      attempt = path.join(directory, `${stem}-${counter}${extension}`);
      counter += 1;
    } catch {
      return attempt;
    }
  }
}

async function saveProcessedImage({ candidate, sourcePath, outputDirectory, settings, paddedUpload = null }) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const crop = Boolean(paddedUpload) || shouldCrop(settings, candidate);
  const percent = Math.min(25, Math.max(1, Number(settings.cropPercent) || 10));
  const cropEdge = paddedUpload?.edge || (settings.cropEdge === 'bottom' ? 'bottom' : 'top');
  let buffer = candidate.buffer;
  let extension = MIME_EXTENSIONS.get(candidate.contentType) || '.png';
  let width = candidate.width;
  let height = candidate.height;
  let appliedCropPercent = 0;

  if (crop) {
    // api-raw 原图本身无 AI 标识，不存在标识溢出白边的问题，补偿为 0（精确裁掉白边即可）
    const compensationPercent = candidate.source === 'api-raw'
      ? 0
      : Number(settings.cropCompensationPercent) || 0;
    const rectangle = paddedUpload
      ? restoreOriginalAspectRectangle(
        candidate.width,
        candidate.height,
        paddedUpload.originalWidth,
        paddedUpload.originalHeight,
        cropEdge,
        compensationPercent
      )
      : cropRectangle(candidate.width, candidate.height, percent, cropEdge);
    const cropped = candidate.image.crop(rectangle);
    buffer = cropped.toPNG();
    extension = '.png';
    width = rectangle.width;
    height = rectangle.height;
    appliedCropPercent = Math.round((candidate.height - rectangle.height) / candidate.height * 1000) / 10;
  }

  const targetPath = await uniquePath(outputDirectory, `${safeStem(sourcePath)}_cleaned`, extension);
  await fs.writeFile(targetPath, buffer);
  return {
    path: targetPath,
    width,
    height,
    cropped: crop,
    cropPercent: crop ? appliedCropPercent : 0,
    cropEdge: crop ? cropEdge : null,
    cropCompensationPercent: candidate.source === 'api-raw' ? 0 : (paddedUpload ? Number(settings.cropCompensationPercent) || 0 : 0),
    removedUploadPadding: Boolean(paddedUpload),
    usedLikelyOriginal: candidate.likelyOriginal,
    discoveryKind: candidate.kind,
    captureSource: candidate.source || null
  };
}

module.exports = {
  cropRectangle,
  downloadBestImage,
  isExactSourceImage,
  paddingPixelsForPercent,
  paintManualMaskOnBitmap,
  prepareManualMarkedUpload,
  preparePaddedUpload,
  watermarkRegionsToStrokes,
  restoreOriginalAspectRectangle,
  saveProcessedImage,
  shouldCrop
};
