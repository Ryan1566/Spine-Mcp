// P7：批量导出工作流。只封装数据导出（json / binary），因为工作流的 -o 是目录语义；
// 渲染导出（png / mov / avi / gif）的 -o 是文件基名，批量跑会互相覆盖，所以仍走 spine_export 单独调用。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSafePath, exportArgs, runSpine } from './spine-cli.mjs';
import { buildExportSettings, DATA_FORMATS } from './export-settings.mjs';
import { projectInfo } from './project-info.mjs';
import { compareExportSkeletons } from './verify-export.mjs';

function jobName(inputPath, format, index) {
  const base = path.basename(inputPath).replace(/\.[^.]+$/, '') || 'project';
  return `${index}-${base}-${format}`;
}

export function buildExportWorkflowPlan({
  projectPath,
  outputDir,
  format = 'json',
  exportSettingsPath,
  extraInputs = [],
  prettyPrint = true,
  nonessential = true,
  verify = false,
  dryRun = false,
} = {}) {
  assertSafePath(projectPath, 'projectPath', { mustExist: true });
  assertSafePath(outputDir, 'outputDir');
  if (!DATA_FORMATS.includes(format)) {
    throw new Error(`format 只支持 ${DATA_FORMATS.join('/')}；渲染导出（png / mov / avi / gif）请直接用 spine_export，它的 -o 是文件基名`);
  }
  if (!Array.isArray(extraInputs)) throw new Error('extraInputs 必须是数组');

  const jobs = [{
    name: jobName(projectPath, format, 0),
    inputPath: projectPath,
    format,
    exportSettingsPath: exportSettingsPath ?? null,
    settingsSource: exportSettingsPath ? 'provided' : 'generated',
  }];
  for (const [index, item] of extraInputs.entries()) {
    assertSafePath(item?.inputPath, `extraInputs[${index}].inputPath`, { mustExist: true });
    const jobFormat = item.format ?? format;
    if (!DATA_FORMATS.includes(jobFormat)) {
      throw new Error(`extraInputs[${index}].format 只支持 ${DATA_FORMATS.join('/')}`);
    }
    if (item.exportSettingsPath) assertSafePath(item.exportSettingsPath, `extraInputs[${index}].exportSettingsPath`, { mustExist: true });
    jobs.push({
      name: jobName(item.inputPath, jobFormat, index + 1),
      inputPath: item.inputPath,
      format: jobFormat,
      exportSettingsPath: item.exportSettingsPath ?? null,
      settingsSource: item.exportSettingsPath ? 'provided' : 'generated',
    });
  }

  const plan = {
    projectPath,
    outputDir,
    jobCount: jobs.length,
    formats: [...new Set(jobs.map((job) => job.format))],
    verify: verify === true,
    jobs,
    settingsOptions: { prettyPrint, nonessential, cleanUp: false },
    note: '生成式设置文件写到系统临时目录，导出完成后默认删除；cleanUp 不会在本工作流开启。',
  };
  if (dryRun) {
    return { dryRun: true, wouldRun: true, ...plan, note: `${plan.note} dryRun：不创建目录、不写设置、不调用 CLI。` };
  }
  return { dryRun: false, ...plan };
}

async function verifyOutputs(projectPath, outputDir) {
  const source = await projectInfo(projectPath);
  if (!source.success || !source.parsed) throw new Error(`无法读取源工程信息: ${projectPath}`);
  const files = (await fs.readdir(outputDir))
    .filter((file) => file.toLowerCase().endsWith('.json') || file.toLowerCase().endsWith('.skel'))
    .sort();
  const items = [];
  for (const file of files) {
    const result = await projectInfo(path.join(outputDir, file));
    items.push({ file, parsed: result.parsed, exitCode: result.exitCode });
  }
  return {
    sourceSkeletons: source.parsed.skeletons.map((s) => s.name),
    checkedFiles: files,
    ...compareExportSkeletons(source.parsed, items),
  };
}

export async function runExportWorkflow(options = {}) {
  const plan = buildExportWorkflowPlan(options);
  if (plan.dryRun) return plan;
  const { prettyPrint, nonessential } = plan.settingsOptions;

  await fs.mkdir(plan.outputDir, { recursive: true });
  const generatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spine-mcp-export-'));
  let response = null;
  try {
    for (const job of plan.jobs) {
      if (job.exportSettingsPath) continue;
      const settings = buildExportSettings({
        format: job.format,
        outputDir: plan.outputDir,
        prettyPrint,
        nonessential,
        cleanUp: false,
      });
      const settingsPath = path.join(generatedDir, `${job.name}.export-settings.json`);
      await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      job.exportSettingsPath = settingsPath;
    }

    const [primary, ...rest] = plan.jobs;
    const args = exportArgs({
      inputPath: primary.inputPath,
      outputDir: plan.outputDir,
      exportSettingsPath: primary.exportSettingsPath,
      clean: false,
      extraInputs: rest.map((job) => ({ inputPath: job.inputPath, exportSettingsPath: job.exportSettingsPath })),
    });
    const result = await runSpine(args);
    response = {
      ...plan,
      command: result.command,
      args,
      exitCode: result.exitCode,
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error ?? null,
      settingsFiles: plan.jobs.map((job) => ({
        job: job.name,
        format: job.format,
        source: job.settingsSource,
        retained: job.settingsSource === 'provided',
        // generated 设置位于临时目录，函数返回前会被删除；路径只用于说明本次实际用了哪个临时文件。
        path: job.settingsSource === 'provided' ? job.exportSettingsPath : null,
        temporaryPath: job.settingsSource === 'generated' ? job.exportSettingsPath : null,
      })),
      generatedSettingsDir: generatedDir,
      temporarySettingsDeleted: false,
    };
    if (result.success && plan.verify) {
      try {
        response.verification = await verifyOutputs(plan.projectPath, plan.outputDir);
      } catch (error) {
        // 导出已经成功，校验失败不能反过来把整个工作流标成失败。
        response.verification = { ok: false, checked: false, error: error.message };
      }
    }
    return response;
  } finally {
    await fs.rm(generatedDir, { recursive: true, force: true });
    if (response) {
      response.generatedSettingsDir = null;
      response.temporarySettingsDeleted = true;
    }
  }
}
