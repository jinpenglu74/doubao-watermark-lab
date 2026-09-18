'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  cropRectangle,
  isExactSourceImage,
  paddingPixelsForPercent,
  paintManualMaskOnBitmap,
  restoreOriginalAspectRectangle,
  watermarkRegionsToStrokes
} = require('../src/image-pipeline');

test('top crop removes pixels from the top edge', () => {
  assert.deepEqual(cropRectangle(1600, 1000, 10, 'top'), {
    x: 0, y: 100, width: 1600, height: 900
  });
});

test('bottom crop keeps the top edge', () => {
  assert.deepEqual(cropRectangle(1600, 1000, 10, 'bottom'), {
    x: 0, y: 0, width: 1600, height: 900
  });
});

test('temporary padding occupies the configured percentage of the padded upload', () => {
  const padding = paddingPixelsForPercent(900, 10);
  assert.equal(padding, 100);
  assert.equal(padding / (900 + padding), 0.1);
});

test('padded result is cropped back to the original aspect ratio from the top', () => {
  assert.deepEqual(restoreOriginalAspectRectangle(1600, 1100, 1600, 1000, 'top'), {
    x: 0, y: 100, width: 1600, height: 1000
  });
});

test('bottom padding can also be removed while preserving the original aspect ratio', () => {
  assert.deepEqual(restoreOriginalAspectRectangle(1600, 1100, 1600, 1000, 'bottom'), {
    x: 0, y: 0, width: 1600, height: 1000
  });
});

test('edge compensation removes a thin top border and preserves the original aspect ratio', () => {
  assert.deepEqual(restoreOriginalAspectRectangle(2400, 1766, 500, 331, 'top', 0.5), {
    x: 6, y: 185, width: 2388, height: 1581
  });
});

test('manual mask paints only the normalized brush area', () => {
  const bitmap = Buffer.alloc(4 * 4 * 4, 0);
  const marked = paintManualMaskOnBitmap(bitmap, 4, 4, [[{ x: 0.5, y: 0.5 }]], 12);
  const centerOffset = (2 * 4 + 2) * 4;
  assert.ok(marked[centerOffset + 2] > 0);
  assert.deepEqual([...marked.subarray(0, 4)], [0, 0, 0, 0]);
  assert.deepEqual([...bitmap], new Array(bitmap.length).fill(0));
});

test('manual mask requires at least one brush stroke', () => {
  assert.throws(
    () => paintManualMaskOnBitmap(Buffer.alloc(16), 2, 2, [], 3),
    /请先在原图上涂抹/
  );
});

test('rejects a downloaded candidate that is exactly the uploaded source file', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'watermark-lab-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'source.png');
  const source = Buffer.from('same-image-bytes');
  await fs.writeFile(sourcePath, source);

  assert.equal(await isExactSourceImage({ buffer: Buffer.from(source) }, sourcePath), true);
});

test('keeps a generated candidate whose bytes differ from the source file', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'watermark-lab-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'source.png');
  await fs.writeFile(sourcePath, Buffer.from('uploaded-image'));

  assert.equal(await isExactSourceImage({ buffer: Buffer.from('generated-image') }, sourcePath), false);
});


test('watermark regions become bounded zig-zag strokes for arbitrary image positions', () => {
  const strokes = watermarkRegionsToStrokes([
    { x: 0.02, y: 0.03, w: 0.12, h: 0.06 },
    { x: 0.35, y: 0.62, w: 0.44, h: 0.08 },
    { x: 0.91, y: 0.88, w: 0.12, h: 0.10 }
  ], { brushPercent: 3 });
  assert.equal(strokes.length, 3);
  for (const stroke of strokes) {
    assert.ok(stroke.length >= 2);
    for (const point of stroke) {
      assert.ok(point.x >= 0 && point.x <= 1);
      assert.ok(point.y >= 0 && point.y <= 1);
    }
  }
});

test('watermark region conversion ignores invalid zero-size regions', () => {
  const strokes = watermarkRegionsToStrokes([
    { x: 0.2, y: 0.2, w: 0, h: 0.1 },
    { x: 0.2, y: 0.2, w: 0.1, h: 0 },
    { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }
  ]);
  assert.equal(strokes.length, 1);
});
