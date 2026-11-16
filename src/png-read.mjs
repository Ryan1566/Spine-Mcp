// P15：零依赖 PNG 读取（只用内置 zlib），给对齐校验取前景包围盒用。
//
// 只支持实际会遇到的情况：8 位深度、非隔行、颜色类型 0/2/4/6。
// Spine CLI 导出的 png 都落在这个范围内；遇到别的直接报错而不是猜。
import zlib from 'node:zlib';

const PNG_SIGNATURE = 0x89504e47;
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function readPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw new Error('不是有效的 PNG（文件太短）');
  if (buffer.readUInt32BE(0) !== PNG_SIGNATURE) throw new Error('不是有效的 PNG（签名不符）');

  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (!header) throw new Error('PNG 缺少 IHDR');
  if (header.bitDepth !== 8) throw new Error(`只支持 8 位深度，收到 ${header.bitDepth}`);
  if (header.interlace !== 0) throw new Error('不支持隔行扫描 PNG');
  const channels = CHANNELS[header.colorType];
  if (!channels) throw new Error(`不支持的颜色类型 ${header.colorType}（只支持 0/2/4/6）`);
  if (!idat.length) throw new Error('PNG 缺少 IDAT');

  const { width, height } = header;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('PNG 像素数据长度不足，文件可能被截断');

  const pixels = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      cur[i] = value & 0xff;
    }
  }

  return {
    width,
    height,
    channels,
    colorType: header.colorType,
    pixels,
    hasAlpha: channels === 2 || channels === 4,
  };
}

export function pixelAt(png, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= png.width || py >= png.height) return null;
  const i = (py * png.width + px) * png.channels;
  return {
    r: png.pixels[i],
    g: png.channels >= 3 ? png.pixels[i + 1] : png.pixels[i],
    b: png.channels >= 3 ? png.pixels[i + 2] : png.pixels[i],
    a: png.hasAlpha ? png.pixels[i + png.channels - 1] : 255,
  };
}

// 前景掩膜：有透明背景时按 alpha；导出时设了不透明 background 时按「与角落颜色的色差」。
// 返回的 mask 长度 = width*height，1 表示前景。
export function foregroundMask(png, { tolerance = 10, alphaThreshold = 8 } = {}) {
  const { width, height, channels, pixels, hasAlpha } = png;
  let transparent = 0;
  if (hasAlpha) {
    for (let i = channels - 1; i < pixels.length; i += channels) if (pixels[i] < alphaThreshold) transparent += 1;
  }
  const useAlpha = hasAlpha && transparent > width * height * 0.05;
  const mask = new Uint8Array(width * height);

  let br = 0;
  let bg = 0;
  let bb = 0;
  if (!useAlpha) {
    br = pixels[0];
    bg = channels >= 3 ? pixels[1] : pixels[0];
    bb = channels >= 3 ? pixels[2] : pixels[0];
  }

  let count = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      let fg;
      if (useAlpha) {
        fg = pixels[i + channels - 1] >= alphaThreshold;
      } else {
        const r = pixels[i];
        const g = channels >= 3 ? pixels[i + 1] : r;
        const b = channels >= 3 ? pixels[i + 2] : r;
        fg = Math.abs(r - br) > tolerance || Math.abs(g - bg) > tolerance || Math.abs(b - bb) > tolerance;
      }
      if (!fg) continue;
      mask[y * width + x] = 1;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) {
    return {
      mask,
      mode: useAlpha ? 'alpha' : 'color',
      count: 0,
      ratio: null,
      box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 1, height: 1 },
    };
  }

  const box = { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return {
    mask,
    mode: useAlpha ? 'alpha' : 'color',
    count,
    ratio: box.width / box.height,
    box,
    imageRatio: box.width / box.height,
  };
}
