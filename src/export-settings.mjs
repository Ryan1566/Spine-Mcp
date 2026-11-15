// 生成 3.8.75 的导出设置 JSON（spine_export 的 -e 参数要求文件真实存在）。
// 目前只有 export-json 在本机端到端验证过；其它格式留到 P1 验证后再开放，不猜格式。
import fs from 'node:fs/promises';
import { assertWritableOutput } from './spine-cli.mjs';

// json 与 binary 都已在本机 3.8.75 真实导出验证；图片 / 视频格式仍未验证，不开放。
export const SUPPORTED_FORMATS = ['json', 'binary'];
const CLASS_BY_FORMAT = { json: 'export-json', binary: 'export-binary' };

export function buildExportSettings({
  format = 'json',
  outputDir = 'C:/path/to/output',
  prettyPrint = true,
  nonessential = true,
  cleanUp = false,
} = {}) {
  if (!SUPPORTED_FORMATS.includes(format)) {
    throw new Error(`导出格式 '${format}' 尚未在本机 3.8.75 验证；当前只支持 ${SUPPORTED_FORMATS.join('/')}（图片 / 视频留待后续）`);
  }
  return {
    class: CLASS_BY_FORMAT[format],
    output: outputDir,
    extension: '.json',
    prettyPrint,
    nonessential,
    cleanUp,
    packSource: 'attachments',
    packTarget: 'perskeleton',
    packAtlas: { atlasExtension: '.atlas.txt' },
  };
}

export async function makeExportSettings({ outputPath, overwrite = false, ...options } = {}) {
  const target = assertWritableOutput(outputPath, 'outputPath', overwrite === true);
  const settings = buildExportSettings(options);
  await fs.writeFile(target, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return {
    writtenTo: target,
    format: settings.class,
    settings,
    note: 'spine_export 的 outputDir 会覆盖 settings.output；导出目录不要放在 skeleton 图片目录里。',
  };
}
