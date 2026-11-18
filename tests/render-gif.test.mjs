import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExportSettings } from '../src/export-settings.mjs';
import { renderGif } from '../src/render-gif.mjs';

const projectPath = fileURLToPath(new URL('../fixtures/hero.json', import.meta.url));
const poseA = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAHElEQVR4nGOQk5O7s89NTk6OySiqySnhBgMDAwA2VgUfl9926AAAAABJRU5ErkJggg==', 'base64');
const poseB = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAHElEQVR4nGOUk5NjYGDYt0CDiYGBwSiqySnhBgAgwgRsKWiDEAAAAABJRU5ErkJggg==', 'base64');
const blank = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGOUk5NjAAMmCMXAwAAABpAAXik0ycIAAAAASUVORK5CYII=', 'base64');

test('GIF 用原生 PNG 序列编码，保留所有帧及累计时长', async (t) => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'spine-gif-test-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const outputPath = path.join(out, 'attack');
  const settings = buildExportSettings({ format: 'gif', animation: 'Attack', skin: 'base', fps: 30 });
  let frameBase;
  const result = await renderGif({ projectPath, outputPath, settings }, {
    run: async (args) => {
      frameBase = args[args.indexOf('-o') + 1];
      const native = JSON.parse(await fs.readFile(args[args.indexOf('-e') + 1], 'utf8'));
      assert.equal(native.class, 'export-png');
      assert.equal(native.exportType, 'animation');
      assert.equal(native.outputType, 'filePerFrame');
      assert.equal(native.animation, 'Attack');
      assert.equal(native.skin, 'base');
      assert.equal(native.renderImages, true);
      assert.equal(native.output, frameBase);
      await Promise.all([
        fs.writeFile(`${frameBase}_10.png`, poseA),
        fs.writeFile(`${frameBase}_8.png`, poseA),
        fs.writeFile(`${frameBase}_9.png`, poseB),
      ]);
      return { success: true, exitCode: 0 };
    },
  });
  assert.equal(result.success, true);
  const [gif] = result.outputs;
  assert.deepEqual([gif.width, gif.height, gif.frameCount, gif.durationMs], [3, 2, 3, 100]);
  const bytes = await fs.readFile(`${outputPath}.gif`);
  assert.equal(bytes.subarray(0, 6).toString(), 'GIF89a');
  assert.equal(bytes.at(-1), 0x3b);
  const delays = [];
  const gce = Buffer.from([0x21, 0xf9, 4]);
  for (let next = bytes.indexOf(gce); next !== -1; next = bytes.indexOf(gce, next + 1)) {
    delays.push(bytes.readUInt16LE(next + 4));
  }
  assert.deepEqual(delays, [3, 4, 3]);
  await assert.rejects(fs.stat(path.dirname(frameBase)), { code: 'ENOENT' });
});

test('全空白与缺帧的序列报告失败并保留既有 GIF', async (t) => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'spine-gif-bad-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const outputPath = path.join(out, 'attack');
  const outputFile = `${outputPath}.gif`;
  await fs.writeFile(outputFile, 'original');
  const settings = buildExportSettings({ format: 'gif', animation: 'Attack' });
  for (const [first, next, expect] of [[blank, 1, /全为空白或纯色/], [poseA, 2, /缺失的帧号/]]) {
    const result = await renderGif({ projectPath, outputPath, settings }, {
      run: async (args) => {
        const base = args[args.indexOf('-o') + 1];
        await fs.writeFile(`${base}_0.png`, first);
        await fs.writeFile(`${base}_${next}.png`, first);
        return { success: true, exitCode: 0 };
      },
    });
    assert.equal(result.success, false);
    assert.match(result.error, expect);
    assert.deepEqual(result.outputs, []);
    assert.equal(await fs.readFile(outputFile, 'utf8'), 'original');
  }
});
