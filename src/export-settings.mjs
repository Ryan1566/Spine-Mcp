// 生成 3.8.75 的导出设置 JSON（spine_export 的 -e 参数要求文件真实存在）。
// 数据导出（json / binary）与渲染导出（png / mov / avi / gif）均已在本机 3.8.75 真实导出验证。
// 关键差异：数据导出的 -o 是目录；渲染导出的 -o 是文件基名（png 的 animationType=all 例外，会被当目录）。
import fs from 'node:fs/promises';
import { assertWritableOutput } from './spine-cli.mjs';

// 数据导出：-o 当目录，产物落在目录里。
export const DATA_FORMATS = ['json', 'binary'];
// 渲染导出：-o 当文件基名（png + animationType=all 除外），扩展名由 class 决定，设置里的 extension 会被忽略。
export const RENDER_FORMATS = ['png', 'mov', 'avi', 'gif'];
export const SUPPORTED_FORMATS = [...DATA_FORMATS, ...RENDER_FORMATS];

const CLASS_BY_FORMAT = {
  json: 'export-json',
  binary: 'export-binary',
  png: 'export-png',
  mov: 'export-mov',
  avi: 'export-avi',
  gif: 'export-gif',
};

// 实测：容器格式由 class 决定，写 .mp4 也不影响产物后缀。
export const RENDER_EXTENSION_BY_FORMAT = { png: '.png', mov: '.mov', avi: '.avi', gif: '.gif' };

const FORMAT_BY_RENDER_CLASS = {
  'export-png': 'png',
  'export-mov': 'mov',
  'export-avi': 'avi',
  'export-gif': 'gif',
};

export const ANIMATION_TYPES = ['all', 'single', 'current'];
export const DEFAULT_GIF_FPS = 20;

export function isRenderFormat(format) {
  return RENDER_FORMATS.includes(format);
}

export function isRenderClass(className) {
  return Object.hasOwn(FORMAT_BY_RENDER_CLASS, className);
}

export function formatForRenderClass(className) {
  return FORMAT_BY_RENDER_CLASS[className] ?? null;
}

// 渲染导出的 -o 到底被当成目录还是文件基名：png 多动画时是目录，其余都是文件基名。
export function outputPathKind(format, animationType) {
  if (!isRenderFormat(format)) return 'directory';
  if (format === 'png' && animationType === 'all') return 'directory';
  return 'fileBase';
}

// libgdx 的 Color 只接受 {r,g,b,a} 对象（十六进制字符串会报 Unable to convert value to required type）。
export function parseColor(value, label = 'backgroundColor') {
  if (typeof value !== 'string') throw new Error(`${label} 必须是十六进制颜色字符串，例如 #000000 或 #000000FF`);
  const hex = value.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) {
    throw new Error(`${label} 必须是 #RRGGBB 或 #RRGGBBAA 形式，收到: ${value}`);
  }
  const channel = (index) => Math.round((parseInt(hex.slice(index, index + 2), 16) / 255) * 1e6) / 1e6;
  return {
    r: channel(0),
    g: channel(2),
    b: channel(4),
    a: hex.length === 8 ? channel(6) : 1,
  };
}

function buildRenderSettings({ format, animationType, animation, skeleton, skin, fps, lastFrame, msaa, backgroundColor }) {
  const settings = {
    class: CLASS_BY_FORMAT[format],
    exportType: format === 'gif' ? 'animation' : format === 'png' ? 'image' : 'video',
  };
  for (const [key, value] of Object.entries({ animation, skeleton, skin })) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 必须是非空名称`);
    settings[key] = value;
  }
  if (animation !== undefined) {
    if (animationType !== undefined && animationType !== 'single') {
      throw new Error('指定 animation 时，animationType 必须为 single');
    }
    animationType = 'single';
  }
  if (skeleton !== undefined) settings.skeletonType = 'single';
  if (skin !== undefined) settings.skinType = 'single';
  if (format === 'gif') {
    animationType ??= 'all';
    fps ??= DEFAULT_GIF_FPS;
    settings.skinType ??= 'all';
    Object.assign(settings, {
      renderImages: true, maxBounds: true, rangeStart: -1, rangeEnd: -1,
      outputType: 'singleFile', colors: 256, colorDither: 50, alphaThreshold: 8, alphaDither: 40,
    });
  }
  if (fps !== undefined) {
    if (!Number.isInteger(fps) || fps < 1 || (format === 'gif' && fps > 50)) {
      throw new Error(format === 'gif' ? 'GIF fps 必须是 1 到 50 的整数' : 'fps 必须是正整数');
    }
    settings.fps = fps;
  }
  if (animationType !== undefined) {
    if (!ANIMATION_TYPES.includes(animationType)) {
      throw new Error(`animationType 只支持 ${ANIMATION_TYPES.join('/')}，收到: ${animationType}`);
    }
    settings.animationType = animationType;
  }
  if (lastFrame !== undefined) {
    if (typeof lastFrame !== 'boolean') throw new Error('lastFrame 必须是布尔值');
    settings.lastFrame = lastFrame;
  }
  if (msaa !== undefined) {
    if (!Number.isInteger(msaa) || msaa < 0) throw new Error('msaa 必须是非负整数（实测 4 可用，0 表示关闭）');
    settings.msaa = msaa;
  }
  if (backgroundColor !== undefined) {
    settings.background = parseColor(backgroundColor);
  }
  // 注意：不要写入 scale。实测它按「世界单位 → 像素」解释，0.5 会把 1281px 的图变成 13px，
  // 与「相对自动适配的倍率」直觉不符，因此不开放，交给 CLI 自动适配。
  return settings;
}

export function buildExportSettings({
  format = 'json',
  outputDir = 'C:/path/to/output',
  prettyPrint = true,
  nonessential = true,
  cleanUp = false,
  animationType,
  animation,
  skeleton,
  skin,
  fps,
  lastFrame,
  msaa,
  backgroundColor,
} = {}) {
  if (!SUPPORTED_FORMATS.includes(format)) {
    throw new Error(`不支持的导出格式 '${format}'；可选 ${SUPPORTED_FORMATS.join('/')}`);
  }
  if (isRenderFormat(format)) {
    return buildRenderSettings({ format, animationType, animation, skeleton, skin, fps, lastFrame, msaa, backgroundColor });
  }
  return {
    class: CLASS_BY_FORMAT[format],
    output: outputDir,
    // 3.8.75 会按 extension 决定产物扩展名；binary 内容实测是二进制，必须用 .skel，不能沿用 .json。
    extension: format === 'binary' ? '.skel' : '.json',
    prettyPrint,
    nonessential,
    cleanUp,
    packSource: 'attachments',
    packTarget: 'perskeleton',
    packAtlas: { atlasExtension: '.atlas.txt' },
  };
}

export async function makeExportSettings({ outputPath, overwrite = false, format = 'json', animationType, ...options } = {}) {
  const target = assertWritableOutput(outputPath, 'outputPath', overwrite === true);
  const settings = buildExportSettings({ format, animationType, ...options });
  await fs.writeFile(target, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  if (isRenderFormat(format)) {
    const kind = outputPathKind(format, animationType);
    return {
      writtenTo: target,
      format,
      render: true,
      outputPathKind: kind,
      settings,
      note: kind === 'directory'
        ? '渲染导出：spine_export 的 outputDir（-o）会被当成目录，png 帧直接写进该目录。'
        : '渲染导出：spine_export 的 outputDir（-o）会被当成文件基名，扩展名由设置 class 决定（.png/.mov/.avi/.gif），不要自己再拼后缀。',
    };
  }
  return {
    writtenTo: target,
    format: settings.class,
    render: false,
    outputPathKind: 'directory',
    settings,
    note: 'spine_export 的 outputDir 会覆盖 settings.output；导出目录不要放在 skeleton 图片目录里。',
  };
}

// 读取设置文件的 class，用于判断这次导出属于数据导出还是渲染导出。
export async function readExportSettings(settingsPath) {
  const text = await fs.readFile(settingsPath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`导出设置不是合法 JSON: ${settingsPath}（${error.message}）`);
  }
}

export async function readExportClass(settingsPath) {
  const settings = await readExportSettings(settingsPath);
  return typeof settings?.class === 'string' ? settings.class : null;
}
