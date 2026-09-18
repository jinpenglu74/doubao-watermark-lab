'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg']);
const PASSTHROUGH_EXTENSIONS = new Set(['.webp', '.gif', '.avif']);

function overwriteGuard({ enabled, mode, residualStatus, qcVerdict }) {
  if (!enabled) return { allowed: false, reason: 'disabled' };
  if (mode === 'manual') return { allowed: false, reason: 'manual-skip' };
  if (!['clean', 'repaired-clean'].includes(residualStatus)) {
    return { allowed: false, reason: 'blocked-residual' };
  }
  if (qcVerdict !== 'ok') return { allowed: false, reason: 'blocked-qc' };
  return { allowed: true, reason: 'allowed' };
}

function sniffImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  const brand = buffer.subarray(4, Math.min(buffer.length, 32)).toString('ascii').toLowerCase();
  if (brand.includes('ftypavif') || brand.includes('ftypavis')) return 'avif';
  return '';
}

function sourceFormatForPath(sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === '.png') return 'png';
  if (JPEG_EXTENSIONS.has(ext)) return 'jpeg';
  if (ext === '.webp') return 'webp';
  if (ext === '.gif') return 'gif';
  if (ext === '.avif') return 'avif';
  return '';
}

async function buildOriginalFormatBuffer({ sourcePath, resultPath, nativeImage }) {
  const sourceFormat = sourceFormatForPath(sourcePath);
  if (!sourceFormat) {
    const error = new Error('原图格式暂不支持安全覆盖；结果已保留在输出目录');
    error.code = 'UNSUPPORTED_ORIGINAL_FORMAT';
    throw error;
  }

  const resultBuffer = await fs.readFile(resultPath);
  if (sourceFormat === 'png' || sourceFormat === 'jpeg') {
    const image = nativeImage.createFromBuffer(resultBuffer);
    if (image.isEmpty()) throw new Error('处理结果无法读取，未覆盖原图');
    const encoded = sourceFormat === 'png' ? image.toPNG() : image.toJPEG(95);
    if (!encoded?.length) throw new Error('无法按原图格式重新编码，未覆盖原图');
    return { buffer: encoded, format: sourceFormat };
  }

  const detected = sniffImageFormat(resultBuffer);
  if (PASSTHROUGH_EXTENSIONS.has(path.extname(sourcePath).toLowerCase()) && detected === sourceFormat) {
    return { buffer: resultBuffer, format: sourceFormat };
  }

  const error = new Error('处理结果无法保持原图格式，未覆盖原图；结果已保留在输出目录');
  error.code = 'UNSUPPORTED_ORIGINAL_FORMAT';
  throw error;
}

async function replaceOriginalSafely({ sourcePath, resultPath, nativeImage }) {
  const originalStat = await fs.stat(sourcePath);
  if (!originalStat.isFile()) throw new Error('原图不存在，无法覆盖');

  const encoded = await buildOriginalFormatBuffer({ sourcePath, resultPath, nativeImage });
  const probe = nativeImage.createFromBuffer(encoded.buffer);
  if (probe.isEmpty()) throw new Error('覆盖前校验失败：处理结果无法正常读取');

  const directory = path.dirname(sourcePath);
  const baseName = path.basename(sourcePath);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryPath = path.join(directory, `.${baseName}.watermarklab-new-${nonce}.tmp`);
  const backupPath = path.join(directory, `.${baseName}.watermarklab-backup-${nonce}.bak`);

  let backupCreated = false;
  try {
    await fs.writeFile(temporaryPath, encoded.buffer, { mode: originalStat.mode });
    await fs.chmod(temporaryPath, originalStat.mode).catch(() => {});

    try {
      // 同目录 rename 在支持覆盖的系统上是原子替换；Windows 若拒绝覆盖现有文件则走备份交换。
      await fs.rename(temporaryPath, sourcePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      await fs.rename(sourcePath, backupPath);
      backupCreated = true;
      try {
        await fs.rename(temporaryPath, sourcePath);
      } catch (swapError) {
        await fs.rename(backupPath, sourcePath).catch(() => {});
        backupCreated = false;
        throw swapError;
      }
      await fs.rm(backupPath, { force: true }).catch(() => {});
      backupCreated = false;
    }

    const finalImage = nativeImage.createFromPath(sourcePath);
    if (finalImage.isEmpty()) {
      throw new Error('覆盖后校验失败：原图位置的新文件无法读取');
    }

    if (path.resolve(resultPath) !== path.resolve(sourcePath)) {
      await fs.rm(resultPath, { force: true }).catch(() => {});
    }

    return {
      path: sourcePath,
      format: encoded.format,
      width: finalImage.getSize().width,
      height: finalImage.getSize().height
    };
  } catch (error) {
    if (backupCreated) {
      await fs.rm(sourcePath, { force: true }).catch(() => {});
      await fs.rename(backupPath, sourcePath).catch(() => {});
    }
    throw error;
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    if (backupCreated) await fs.rm(backupPath, { force: true }).catch(() => {});
  }
}

module.exports = {
  buildOriginalFormatBuffer,
  overwriteGuard,
  replaceOriginalSafely,
  sniffImageFormat,
  sourceFormatForPath
};
