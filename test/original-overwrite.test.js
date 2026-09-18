'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  overwriteGuard,
  replaceOriginalSafely,
  sniffImageFormat,
  sourceFormatForPath
} = require('../src/original-overwrite');

test('覆盖原图只在自动流程、残留复检通过且像素质检正常时放行', () => {
  assert.deepEqual(
    overwriteGuard({ enabled: true, mode: 'batch', residualStatus: 'clean', qcVerdict: 'ok' }),
    { allowed: true, reason: 'allowed' }
  );
  assert.equal(overwriteGuard({ enabled: false, mode: 'batch', residualStatus: 'clean', qcVerdict: 'ok' }).reason, 'disabled');
  assert.equal(overwriteGuard({ enabled: true, mode: 'manual', residualStatus: 'manual-skip', qcVerdict: 'ok' }).reason, 'manual-skip');
  assert.equal(overwriteGuard({ enabled: true, mode: 'batch', residualStatus: 'review', qcVerdict: 'ok' }).reason, 'blocked-residual');
  assert.equal(overwriteGuard({ enabled: true, mode: 'batch', residualStatus: 'clean', qcVerdict: 'unchanged' }).reason, 'blocked-qc');
});

test('识别原图可安全保持的格式', () => {
  assert.equal(sourceFormatForPath('a.jpg'), 'jpeg');
  assert.equal(sourceFormatForPath('a.jpeg'), 'jpeg');
  assert.equal(sourceFormatForPath('a.png'), 'png');
  assert.equal(sourceFormatForPath('a.webp'), 'webp');
  assert.equal(sourceFormatForPath('a.gif'), 'gif');
  assert.equal(sourceFormatForPath('a.avif'), 'avif');
  assert.equal(sourceFormatForPath('a.heic'), '');
  assert.equal(sourceFormatForPath('a.bmp'), '');
});

test('图片魔数识别覆盖 PNG/JPEG/GIF/WEBP', () => {
  assert.equal(sniffImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), 'png');
  assert.equal(sniffImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpeg');
  assert.equal(sniffImageFormat(Buffer.from('GIF89a______')), 'gif');
  assert.equal(sniffImageFormat(Buffer.from('RIFF____WEBP')), 'webp');
});

test('安全覆盖会把结果按原 PNG 格式写回原路径并删除中间结果', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'watermark-overwrite-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'source.png');
  const resultPath = path.join(directory, 'source_cleaned.jpg');
  await fs.writeFile(sourcePath, Buffer.from('original'));
  await fs.writeFile(resultPath, Buffer.from('processed'));

  const fakeNativeImage = {
    createFromBuffer(buffer) {
      return {
        isEmpty: () => false,
        toPNG: () => Buffer.from(`PNG-ENCODED:${buffer.toString()}`),
        toJPEG: () => Buffer.from(`JPEG-ENCODED:${buffer.toString()}`)
      };
    },
    createFromPath() {
      return {
        isEmpty: () => false,
        getSize: () => ({ width: 1200, height: 800 })
      };
    }
  };

  const replaced = await replaceOriginalSafely({ sourcePath, resultPath, nativeImage: fakeNativeImage });
  assert.equal(replaced.path, sourcePath);
  assert.equal(replaced.format, 'png');
  assert.equal((await fs.readFile(sourcePath)).toString(), 'PNG-ENCODED:processed');
  await assert.rejects(fs.access(resultPath));
});
