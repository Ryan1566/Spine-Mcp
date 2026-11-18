// GIF 只支持二值透明度。索引 0 留给透明像素，其余颜色按帧生成局部调色板。
const COLOR_BINS = 32769;

function indexedFrame({ width, height, channels, pixels, hasAlpha }) {
  const indices = new Uint8Array(width * height);
  const bins = new Uint16Array(indices.length);
  const colors = new Map();
  for (let i = 0, p = 0; i < indices.length; i += 1, p += channels) {
    if (hasAlpha && pixels[p + channels - 1] < 128) continue;
    const r = pixels[p];
    const g = channels >= 3 ? pixels[p + 1] : r;
    const b = channels >= 3 ? pixels[p + 2] : r;
    const code = 1 + ((r >> 3) << 10 | (g >> 3) << 5 | b >> 3);
    bins[i] = code;
    let sample = colors.get(code);
    if (!sample) {
      sample = { code, count: 0, rgb: [0, 0, 0] };
      colors.set(code, sample);
    }
    sample.count += 1;
    sample.rgb[0] += r;
    sample.rgb[1] += g;
    sample.rgb[2] += b;
  }
  const buckets = [...colors.values()];
  const makeBox = (items) => {
    const low = [255, 255, 255];
    const high = [0, 0, 0];
    let count = 0;
    for (const item of items) {
      count += item.count;
      for (let axis = 0; axis < 3; axis += 1) {
        const value = item.rgb[axis] / item.count;
        low[axis] = Math.min(low[axis], value);
        high[axis] = Math.max(high[axis], value);
      }
    }
    const ranges = high.map((value, axis) => value - low[axis]);
    const range = Math.max(...ranges);
    return { items, count, axis: ranges.indexOf(range), range };
  };
  const boxes = buckets.length <= 255 ? buckets.map((item) => makeBox([item])) : [makeBox(buckets)];
  while (boxes.length < 255 && boxes.length < buckets.length) {
    boxes.sort((a, b) => b.range - a.range);
    const { items, count, axis } = boxes.shift();
    items.sort((a, b) => a.rgb[axis] / a.count - b.rgb[axis] / b.count);
    let split = 1;
    let cumulative = items[0].count;
    while (split < items.length - 1 && cumulative < count / 2) {
      cumulative += items[split].count;
      split += 1;
    }
    boxes.push(makeBox(items.slice(0, split)), makeBox(items.slice(split)));
  }
  const palette = Buffer.alloc(256 * 3);
  const lookup = new Uint8Array(COLOR_BINS);
  boxes.forEach(({ items, count }, i) => {
    for (const { code } of items) lookup[code] = i + 1;
    for (let channel = 0; channel < 3; channel += 1) {
      palette[(i + 1) * 3 + channel] = Math.round(items.reduce((sum, item) => sum + item.rgb[channel], 0) / count);
    }
  });
  for (let i = 0; i < bins.length; i += 1) indices[i] = lookup[bins[i]];
  return { indices, palette, foreground: buckets.length > 1 || (buckets.length === 1 && indices.includes(0)) };
}

function lzwBlocks(indices) {
  const dictionary = new Map();
  const bytes = Buffer.allocUnsafe(indices.length * 2 + 10);
  let offset = 0;
  let bits = 0;
  let pending = 0;
  let width = 9;
  let next = 258;
  const write = (code) => {
    pending |= code << bits;
    bits += width;
    while (bits >= 8) {
      bytes[offset++] = pending & 255;
      pending >>= 8;
      bits -= 8;
    }
  };
  write(256);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const pixel = indices[i];
    const key = prefix * 256 + pixel;
    const existing = dictionary.get(key);
    if (existing !== undefined) {
      prefix = existing;
      continue;
    }
    write(prefix);
    if (next === 4096) {
      write(256);
      dictionary.clear();
      next = 258;
      width = 9;
    } else {
      if (next === 1 << width) width += 1;
      dictionary.set(key, next++);
    }
    prefix = pixel;
  }
  write(prefix);
  if (next === 1 << width && width < 12) width += 1;
  write(257);
  if (bits > 0) bytes[offset++] = pending;
  const blocks = [Buffer.from([8])];
  for (let i = 0; i < offset; i += 255) {
    const block = bytes.subarray(i, Math.min(i + 255, offset));
    blocks.push(Buffer.from([block.length]), block);
  }
  blocks.push(Buffer.from([0]));
  return blocks;
}

export async function encodeGif(frames, { fps, repeat = 0 } = {}) {
  if (!Number.isFinite(fps) || fps < 1 || fps > 50) throw new Error('GIF fps 必须在 1 到 50 之间');
  if (!Number.isInteger(repeat) || repeat < 0 || repeat > 65535) throw new Error('GIF repeat 必须是 0 到 65535 的整数');
  const chunks = [];
  let width, height;
  let frameCount = 0;
  let duration = 0;
  let hasForeground = false;
  for await (const frame of frames) {
    if (!frameCount) {
      ({ width, height } = frame);
      if (width < 1 || height < 1 || (width === 1 && height === 1) || width > 65535 || height > 65535) {
        throw new Error(`无效的 GIF 画布尺寸: ${width}×${height}`);
      }
      const header = Buffer.from('47494638396100000000f00000000000000000', 'hex');
      header.writeUInt16LE(width, 6);
      header.writeUInt16LE(height, 8);
      const loop = Buffer.from('21ff0b4e45545343415045322e300301000000', 'hex');
      loop.writeUInt16LE(repeat, 16);
      chunks.push(header, loop);
    }
    if (frame.width !== width || frame.height !== height) throw new Error('GIF 帧画布尺寸不一致');
    const { indices, palette, foreground } = indexedFrame(frame);
    hasForeground ||= foreground;
    frameCount += 1;
    // GIF 的延时以百分之一秒为单位。先累计再取整，避免 30fps 每帧取整后总时长变短。
    const end = Math.round(frameCount * 100 / fps);
    const control = Buffer.from([0x21, 0xf9, 4, 9, 0, 0, 0, 0]);
    control.writeUInt16LE(end - duration, 4);
    duration = end;
    const descriptor = Buffer.from([0x2c, 0, 0, 0, 0, 0, 0, 0, 0, 0x87]);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    chunks.push(control, descriptor, palette, ...lzwBlocks(indices));
  }
  if (!hasForeground) throw new Error('PNG 序列全为空白或纯色，请检查皮肤选择与纹理路径');
  chunks.push(Buffer.from([0x3b]));
  return { bytes: Buffer.concat(chunks), width, height, frameCount, durationMs: duration * 10 };
}
