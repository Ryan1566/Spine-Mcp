// P7：批量导出工作流（数据导出 json / binary）。P11 扩展为「多工程 × 多格式矩阵 + 统一产物报告」。
// 渲染导出（png / mov / avi / gif）的 -o 是文件基名，批量跑会互相覆盖，因此仍走 spine_export 单独调用。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSafePath, exportArgs, runSpine } from './spine-cli.mjs';
import { assertDirectory, packArgs } from './atlas.mjs';
import { buildExportSettings, DATA_FORMATS } from './export-settings.mjs';
import { verifyExport } from './verify-export.mjs';

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

// 图集打包是可选的收尾步骤：把 images 目录打成 atlas + png，和数据产物放在一起。
function normalizePack(pack, { outputDir, multiProject }) {
  if (pack === undefined || pack === null || pack === false) return null;
  if (typeof pack !== 'object' || Array.isArray(pack)) throw new Error('pack 必须是对象');
  const imageDir = assertDirectory(pack.imageDir, 'pack.imageDir');
  const targetDir = pack.outputDir ?? outputDir;
  assertSafePath(targetDir, 'pack.outputDir');
  if (multiProject && !pack.outputDir) {
    throw new Error('多工程导出时必须显式指定 pack.outputDir（每个工程的图片目录不同，不能混在一个图集里）');
  }
  const projectPaths = normalizeList(pack.projectPaths, 'pack.projectPaths');
  const resolved = {
    imageDir,
    outputDir: targetDir,
    name: pack.name,
    settingsPath: pack.settingsPath,
    projectPaths,
  };
  // packArgs 会在这里做完整校验（图片目录、设置文件、图集名三者的组合规则）。
  resolved.args = packArgs({
    inputDir: imageDir,
    outputDir: targetDir,
    atlasName: pack.name,
    packSettingsPath: pack.settingsPath,
    projectPaths,
  });
  return resolved;
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
  pack,
  dryRun = false,
} = {}) {
  assertSafePath(outputDir, 'outputDir');

  const projectList = [...(projectPath ? [projectPath] : []), ...normalizeList(projects, 'projects')];
  if (projectList.length === 0) throw new Error('必须提供 projectPath 或 projects');
  for (const [index, item] of projectList.entries()) {
    assertSafePath(item, projectList.length > 1 ? `projects[${index}]` : 'projectPath', { mustExist: true });
  }
  // 同一工程传两次没有意义，按首次出现去重，避免产物被重复覆盖。
  const matrixProjects = [...new Set(projectList)];

  const formatList = normalizeList(formats, 'formats');
  const effectiveFormats = formatList.length > 0 ? [...new Set(formatList)] : [format];
  for (const item of effectiveFormats) {
    if (!DATA_FORMATS.includes(item)) {
      throw new Error(`format 只支持 ${DATA_FORMATS.join('/')}；渲染导出（png / mov / avi / gif）请直接用 spine_export，它的 -o 是文件基名`);
    }
  }
  if (!Array.isArray(extraInputs)) throw new Error('extraInputs 必须是数组');

  const jobs = [];
  for (const inputPath of matrixProjects) {
    for (const item of effectiveFormats) {
      jobs.push({
        name: jobName(inputPath, item, jobs.length),
        inputPath,
        format: item,
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
  const uniqueProjects = [...new Set(jobs.map((job) => job.inputPath))];
  const multiProject = uniqueProjects.length > 1;
  const projectDirs = uniqueProjects.map((inputPath, index) => ({
    inputPath,
    dir: multiProject ? path.join(outputDir, projectDirName(index, inputPath)) : outputDir,
  }));
  for (const job of jobs) {
    job.projectIndex = uniqueProjects.indexOf(job.inputPath);
    job.outputDir = projectDirs[job.projectIndex].dir;
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
    pack: normalizePack(pack, { outputDir, multiProject }),
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

// CLI 失败时不一定会回 error 对象（多为非零退出码 + stderr），把最后一行的有效信息提出来，避免 error:null 掩盖原因。
export function failureHint(stdout, stderr) {
  const lines = `${stderr ?? ''}\n${stdout ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const meaningful = [...lines].reverse().find((line) => /error|exception|caused by|does not fit|not found|invalid/i.test(line));
  const chosen = meaningful ?? lines[lines.length - 1];
  return chosen ? chosen.slice(0, 300) : null;
}

// 对照每个 job 前后的文件状态；刚生成的旧文件也不能计入本次产物。
async function snapshotJobDirectory(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    const stat = await fs.stat(full, { bigint: true }).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!stat?.isFile() || stat.size === 0n) continue;
    files.set(entry.name, {
      path: full,
      name: entry.name,
      sizeBytes: Number(stat.size),
      stamp: [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'),
    });
  }
  return files;
}

async function collectJobOutputs(dir, format, before) {
  const after = await snapshotJobDirectory(dir);
  return [...after.values()]
    .filter((file) => before.get(file.name)?.stamp !== file.stamp)
    .map(({ stamp, ...file }) => ({ ...file, primary: file.name.toLowerCase().endsWith(DATA_EXTENSION[format]) }))
    .sort((a, b) => a.name.localeCompare(b.name));
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

// 打包产物：atlas 文本（.atlas / .atlas.txt）与页图片。
const PACK_SUFFIXES = ['.atlas', '.atlas.txt', '.png'];

async function collectPackOutputs(dir, startedAt, toleranceMs = 3000) {
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
    const lower = entry.name.toLowerCase();
    if (!PACK_SUFFIXES.some((suffix) => lower.endsWith(suffix))) continue;
    const full = path.join(dir, entry.name);
    const stat = await statOrNull(full);
    if (!stat || stat.size === 0 || stat.mtimeMs < threshold) continue;
    files.push({ path: full, name: entry.name, sizeBytes: stat.size });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function runPackStage(plan, excludePaths = new Set()) {
  if (!plan.pack) return null;
  await fs.mkdir(plan.pack.outputDir, { recursive: true });
  const startedAt = Date.now();
  const result = await runSpine(plan.pack.args);
  // 同目录里数据导出产出的 .atlas.txt / .png 已经计入 job 产物，打包报告只算本次新增的图集文件。
  const files = result.success
    ? (await collectPackOutputs(plan.pack.outputDir, startedAt)).filter((file) => !excludePaths.has(file.path))
    : [];
  return {
    success: result.success,
    exitCode: result.exitCode,
    command: result.command,
    args: plan.pack.args,
    imageDir: plan.pack.imageDir,
    outputDir: plan.pack.outputDir,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error ?? (result.success ? null : failureHint(result.stdout, result.stderr)),
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
}

export async function runExportWorkflow(options = {}, { runSpineCli = runSpine, verifyFiles = verifyExport } = {}) {
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
      const before = await snapshotJobDirectory(job.outputDir);
      const args = exportArgs({
        inputPath: job.inputPath,
        outputDir: job.outputDir,
        exportSettingsPath: job.exportSettingsPath,
        clean: false,
        extraInputs: [],
      });
      const result = await runSpineCli(args);
      const files = result.success ? await collectJobOutputs(job.outputDir, job.format, before) : [];
      const fileCount = files.filter((file) => file.primary).length;
      const success = result.success && fileCount > 0;
      runs.push({
        job: job.name,
        inputPath: job.inputPath,
        format: job.format,
        outputDir: job.outputDir,
        exitCode: result.exitCode,
        success,
        error: result.success
          ? (success ? null : `Spine CLI 未生成本次 ${job.format} 主产物`)
          : (result.error ?? failureHint(result.stdout, result.stderr)),
        command: result.command,
        args,
        stdout: result.stdout,
        stderr: result.stderr,
        files,
        fileCount,
        byproductCount: files.filter((file) => !file.primary).length,
        totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      });
    }

    const dataSuccess = runs.every((run) => run.success);
    const firstFailure = runs.find((run) => !run.success);
    const uniqueFiles = new Map(mergeRunFiles(runs).map((file) => [file.path, file]));
    // 打包是收尾步骤：数据导出失败就没必要再打图集。
    const packResult = dataSuccess ? await runPackStage(plan, new Set(uniqueFiles.keys())) : null;
    const success = dataSuccess && (packResult ? packResult.success : true);

    response = {
      ...plan,
      command: runs[0]?.command ?? null,
      args: runs[0]?.args ?? [],
      exitCode: success ? 0 : (firstFailure?.exitCode || packResult?.exitCode || -1),
      success,
      stdout: [...runs.map((run) => run.stdout), packResult?.stdout ?? ''].join('').slice(0, 20000),
      stderr: [...runs.map((run) => run.stderr), packResult?.stderr ?? ''].join('').slice(0, 20000),
      error: success ? null : (firstFailure?.error ?? packResult?.error ?? '导出失败'),
      runs,
      packResult,
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
        // 打包产物单独统计：它不属于任何一个数据 job，混进 fileCount 会误导。
        pack: packResult ? {
          success: packResult.success,
          fileCount: packResult.fileCount,
          totalBytes: packResult.totalBytes,
        } : null,
      },
      generatedSettingsDir: generatedDir,
      temporarySettingsDeleted: false,
    };

    if (dataSuccess && plan.verify) {
      // 一个工程可能导出多种格式，只校验本次各 job 确认写入的主产物。
      const verifications = [];
      const byDir = new Map();
      for (const run of runs) {
        const group = byDir.get(run.outputDir) ?? { projectPath: run.inputPath, files: new Set() };
        for (const file of run.files) if (file.primary) group.files.add(file.name);
        byDir.set(run.outputDir, group);
      }
      for (const [outputDir, { projectPath, files }] of byDir) {
        try {
          verifications.push({ outputDir, ...(await verifyFiles({ projectPath, exportDir: outputDir }, [...files])) });
        } catch (error) {
          verifications.push({ outputDir, ok: false, checked: false, error: error.message });
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
