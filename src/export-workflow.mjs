// P7：批量导出工作流（数据导出 json / binary）。P11 扩展为「多工程 × 多格式矩阵 + 统一产物报告」。
// 渲染导出（png / mov / avi / gif）的 -o 是文件基名，批量跑会互相覆盖，因此仍走 spine_export 单独调用。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSafePath, exportArgs, runSpine } from './spine-cli.mjs';
import { buildExportSettings, DATA_FORMATS } from './export-settings.mjs';
import { projectInfo } from './project-info.mjs';
import { compareExportSkeletons } from './verify-export.mjs';

// 每个数据格式的产物扩展名，用于把文件归到具体 job。
const DATA_EXTENSION = { json: '.json', binary: '.skel' };

function jobName(inputPath, format, index) {
  const base = path.basename(inputPath).replace(/\.[^.]+$/, '') || 'project';
  return `${index}-${base}-${format}`;
}

function projectDirName(index, inputPath) {
  const base = path.basename(inputPath).replace(/\.[^.]+$/, '') || 'project';
  return `${index}-${base}`;
}

function normalizeList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value;
}

export function buildExportWorkflowPlan({
  projectPath,
  projects = [],
  outputDir,
  format = 'json',
  formats = [],
  exportSettingsPath,
  extraInputs = [],
  prettyPrint = true,
  nonessential = true,
  verify = false,
  dryRun = false,
} = {}) {
  assertSafePath(outputDir, 'outputDir');

  const projectList = [...(projectPath ? [projectPath] : []), ...normalizeList(projects, 'projects')];
  if (projectList.length === 0) throw new Error('必须提供 projectPath 或 projects');
  for (const [index, item] of projectList.entries()) {
    assertSafePath(item, projectList.length > 1 ? `projects[${index}]` : 'projectPath', { mustExist: true });
  }
  // 同一工程传两次没有意义，按首次出现去重，避免产物被重复覆盖。
  const uniqueProjects = [...new Set(projectList)];

  const formatList = normalizeList(formats, 'formats');
  const effectiveFormats = formatList.length > 0 ? [...new Set(formatList)] : [format];
  for (const item of effectiveFormats) {
    if (!DATA_FORMATS.includes(item)) {
      throw new Error(`format 只支持 ${DATA_FORMATS.join('/')}；渲染导出（png / mov / avi / gif）请直接用 spine_export，它的 -o 是文件基名`);
    }
  }
  if (!Array.isArray(extraInputs)) throw new Error('extraInputs 必须是数组');

  const jobs = [];
  for (const [projectIndex, inputPath] of uniqueProjects.entries()) {
    for (const item of effectiveFormats) {
      jobs.push({
        name: jobName(inputPath, item, jobs.length),
        inputPath,
        format: item,
        projectIndex,
        exportSettingsPath: null,
        settingsSource: 'generated',
      });
    }
  }
  for (const [index, item] of extraInputs.entries()) {
    assertSafePath(item?.inputPath, `extraInputs[${index}].inputPath`, { mustExist: true });
    const jobFormat = item.format ?? effectiveFormats[0];
    if (!DATA_FORMATS.includes(jobFormat)) {
      throw new Error(`extraInputs[${index}].format 只支持 ${DATA_FORMATS.join('/')}`);
    }
    if (item.exportSettingsPath) assertSafePath(item.exportSettingsPath, `extraInputs[${index}].exportSettingsPath`, { mustExist: true });
    jobs.push({
      name: jobName(item.inputPath, jobFormat, jobs.length),
      inputPath: item.inputPath,
      format: jobFormat,
      projectIndex: uniqueProjects.indexOf(item.inputPath),
      exportSettingsPath: item.exportSettingsPath ?? null,
      settingsSource: item.exportSettingsPath ? 'provided' : 'generated',
    });
  }

  // 用户提供的设置文件只能对应唯一 job，否则无法判断该给哪个工程/格式用。
  if (exportSettingsPath) {
    assertSafePath(exportSettingsPath, 'exportSettingsPath', { mustExist: true });
    if (jobs.length !== 1) throw new Error('exportSettingsPath 只能用于单工程单格式；多 job 请改用 extraInputs[].exportSettingsPath');
    jobs[0].exportSettingsPath = exportSettingsPath;
    jobs[0].settingsSource = 'provided';
  }

  // 单个工程时沿用原来的「产物直接落在 outputDir」，多工程时按工程分子目录，避免同名 skeleton 互相覆盖。
  const multiProject = uniqueProjects.length > 1;
  const projectDirs = uniqueProjects.map((inputPath, index) => ({
    inputPath,
    dir: multiProject ? path.join(outputDir, projectDirName(index, inputPath)) : outputDir,
  }));
  for (const job of jobs) {
    const matched = projectDirs.find((item) => item.inputPath === job.inputPath);
    job.outputDir = matched?.dir ?? outputDir;
  }

  const plan = {
    projectPath: projectPath ?? uniqueProjects[0],
    projects: uniqueProjects,
    outputDir,
    jobCount: jobs.length,
    formats: [...new Set(jobs.map((job) => job.format))],
    layout: multiProject ? 'perProject' : 'flat',
    projectDirs,
    verify: verify === true,
    jobs,
    settingsOptions: { prettyPrint, nonessential, cleanUp: false },
    note: '生成式设置文件写到系统临时目录，导出完成后默认删除；cleanUp 不会在本工作流开启。多工程时每个工程一个子目录。',
  };
  if (dryRun) {
    return { dryRun: true, wouldRun: true, ...plan, note: `${plan.note} dryRun：不创建目录、不写设置、不调用 CLI。` };
  }
  return { dryRun: false, ...plan };
}

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

// 只认本次 job 期间新写出的产物，避免把上一次的文件算进来。
// primary=true 表示与该 job 的格式对应的主产物；atlas / png 这类是同目录附带产物。
async function collectJobOutputs(dir, format, startedAt, toleranceMs = 3000) {
  const extension = DATA_EXTENSION[format];
  if (!extension) throw new Error(`不支持的产物格式: ${format}`);
  const threshold = startedAt - toleranceMs;
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    const stat = await statOrNull(full);
    if (!stat || stat.size === 0 || stat.mtimeMs < threshold) continue;
    files.push({
      path: full,
      name: entry.name,
      sizeBytes: stat.size,
      primary: entry.name.toLowerCase().endsWith(extension),
    });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function verifyDir(projectPath, dir) {
  const source = await projectInfo(projectPath);
  if (!source.success || !source.parsed) throw new Error(`无法读取源工程信息: ${projectPath}`);
  const files = (await fs.readdir(dir))
    .filter((file) => file.toLowerCase().endsWith('.json') || file.toLowerCase().endsWith('.skel'))
    .sort();
  const items = [];
  for (const file of files) {
    const result = await projectInfo(path.join(dir, file));
    items.push({ file, parsed: result.parsed, exitCode: result.exitCode });
  }
  return {
    sourceSkeletons: source.parsed.skeletons.map((s) => s.name),
    checkedFiles: files,
    ...compareExportSkeletons(source.parsed, items),
  };
}

// 同一目录里 json / binary 两个 job 会看到同一批 atlas / png，按路径去重；
// 同一文件在不同 job 眼里分别是主产物 / 附带产物，只要有任一 job 认定为主产物就算主产物。
export function mergeRunFiles(runs = []) {
  const unique = new Map();
  for (const run of runs) {
    for (const file of run?.files ?? []) {
      const existing = unique.get(file.path);
      if (existing) existing.primary = existing.primary || file.primary;
      else unique.set(file.path, { ...file });
    }
  }
  return [...unique.values()];
}

export async function runExportWorkflow(options = {}) {
  const plan = buildExportWorkflowPlan(options);
  if (plan.dryRun) return plan;
  const { prettyPrint, nonessential } = plan.settingsOptions;

  await fs.mkdir(plan.outputDir, { recursive: true });
  const generatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spine-mcp-export-'));
  let response = null;
  try {
    // 每个 job 一次 CLI 调用：这样产物可以按 job 归属，也避免不同工程写进同一目录。
    for (const job of plan.jobs) {
      if (job.exportSettingsPath) continue;
      const settings = buildExportSettings({
        format: job.format,
        outputDir: job.outputDir,
        prettyPrint,
        nonessential,
        cleanUp: false,
      });
      const settingsPath = path.join(generatedDir, `${job.name}.export-settings.json`);
      await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      job.exportSettingsPath = settingsPath;
    }

    const runs = [];
    for (const job of plan.jobs) {
      await fs.mkdir(job.outputDir, { recursive: true });
      const startedAt = Date.now();
      const args = exportArgs({
        inputPath: job.inputPath,
        outputDir: job.outputDir,
        exportSettingsPath: job.exportSettingsPath,
        clean: false,
        extraInputs: [],
      });
      const result = await runSpine(args);
      const files = result.success ? await collectJobOutputs(job.outputDir, job.format, startedAt) : [];
      runs.push({
        job: job.name,
        inputPath: job.inputPath,
        format: job.format,
        outputDir: job.outputDir,
        exitCode: result.exitCode,
        success: result.success,
        error: result.error ?? null,
        command: result.command,
        args,
        stdout: result.stdout,
        stderr: result.stderr,
        files,
        fileCount: files.filter((file) => file.primary).length,
        byproductCount: files.filter((file) => !file.primary).length,
        totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      });
    }

    const success = runs.every((run) => run.success);
    const firstFailure = runs.find((run) => !run.success);
    const uniqueFiles = new Map(mergeRunFiles(runs).map((file) => [file.path, file]));

    response = {
      ...plan,
      command: runs[0]?.command ?? null,
      args: runs[0]?.args ?? [],
      exitCode: success ? 0 : (firstFailure?.exitCode ?? -1),
      success,
      stdout: runs.map((run) => run.stdout).join('').slice(0, 20000),
      stderr: runs.map((run) => run.stderr).join('').slice(0, 20000),
      error: success ? null : (firstFailure?.error ?? '至少有一个 job 失败'),
      runs,
      settingsFiles: plan.jobs.map((job) => ({
        job: job.name,
        format: job.format,
        source: job.settingsSource,
        retained: job.settingsSource === 'provided',
        // generated 设置位于临时目录，函数返回前会被删除；路径只用于说明本次实际用了哪个临时文件。
        path: job.settingsSource === 'provided' ? job.exportSettingsPath : null,
        temporaryPath: job.settingsSource === 'generated' ? job.exportSettingsPath : null,
      })),
      report: {
        jobCount: runs.length,
        succeeded: runs.filter((run) => run.success).length,
        failed: runs.filter((run) => !run.success).length,
        // 同一目录里 json / binary 两个 job 会看到同一批 atlas / png，按路径去重后再统计总量。
        fileCount: uniqueFiles.size,
        primaryFiles: [...uniqueFiles.values()].filter((file) => file.primary).length,
        byproductFiles: [...uniqueFiles.values()].filter((file) => !file.primary).length,
        totalBytes: [...uniqueFiles.values()].reduce((sum, file) => sum + file.sizeBytes, 0),
        byFormat: Object.fromEntries([...new Set(runs.map((run) => run.format))].map((format) => {
          const subset = runs.filter((run) => run.format === format);
          const primary = subset.flatMap((run) => run.files.filter((file) => file.primary));
          return [format, {
            jobs: subset.length,
            files: primary.length,
            bytes: primary.reduce((sum, file) => sum + file.sizeBytes, 0),
          }];
        })),
      },
      generatedSettingsDir: generatedDir,
      temporarySettingsDeleted: false,
    };

    if (success && plan.verify) {
      // 同一目录里可能有多份产物（一个工程的 json + binary），按目录去重后再校验。
      const verifications = [];
      const seen = new Set();
      for (const run of runs) {
        if (seen.has(run.outputDir)) continue;
        seen.add(run.outputDir);
        try {
          verifications.push({ outputDir: run.outputDir, ...(await verifyDir(run.inputPath, run.outputDir)) });
        } catch (error) {
          // 导出已经成功，校验失败不能反过来把整个工作流标成失败。
          verifications.push({ outputDir: run.outputDir, ok: false, checked: false, error: error.message });
        }
      }
      response.verification = verifications.length === 1
        ? verifications[0]
        : { ok: verifications.every((item) => item.ok === true), dirs: verifications };
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
