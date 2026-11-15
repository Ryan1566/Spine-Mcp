#!/usr/bin/env node
// 「现在这套 MCP 是不是最新的？」——调用 spine 工具之前先跑这个。
//
//   node scripts/check-update.mjs          # 人看
//   node scripts/check-update.mjs --json   # 机读
//
// 退出码：0 = 运行实例与磁盘一致；1 = 有实例落后于磁盘（需要重载）；
//         2 = 没找到活着的实例（可能宿主还没拉起 / 或已停用）。
//
// 原理：src/index.mjs 启动时把 src/*.mjs 的指纹写到 .runtime/server-<pid>.json，
// 这里把那份指纹跟磁盘现状逐个比对。MCP 进程是宿主 spawn 的，改磁盘不会热更新，
// 所以「磁盘更新了但进程没重开」是默认状态，不是异常。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  REPO_ROOT,
  SRC_DIR,
  STATE_DIR,
  listRuntimeStates,
  sourceFingerprint,
} from '../src/build-info.mjs';

const asJson = process.argv.includes('--json');

function gitSummary() {
  const run = (...args) => {
    try {
      const out = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 4000 });
      if (out.error || out.status !== 0) return null;
      return String(out.stdout).trim();
    } catch {
      return null;
    }
  };
  const head = run('log', '-1', '--format=%h %ci %s');
  const dirty = run('status', '--porcelain');
  if (head === null) return { available: false, note: '读不到 git（沙箱内 spawn 被限制时属正常）' };
  return { available: true, head, uncommittedFiles: dirty ? dirty.split('\n').length : 0, dirtyLines: dirty ? dirty.split('\n') : [] };
}

function diffFiles(disk, state) {
  const before = state.files ?? {};
  const changed = [];
  for (const [file, hash] of Object.entries(disk.files)) {
    if (before[file] === undefined) changed.push(`新增 ${file}`);
    else if (before[file] !== hash) changed.push(`改动 ${file}`);
  }
  for (const file of Object.keys(before)) {
    if (disk.files[file] === undefined) changed.push(`删除 ${file}`);
  }
  return changed;
}

const disk = sourceFingerprint(SRC_DIR);
const states = listRuntimeStates(STATE_DIR, { prune: true });

let diskToolNames = null;
try {
  const mod = await import('../src/tools.mjs');
  diskToolNames = mod.TOOLS.map((tool) => tool.name);
} catch (err) {
  diskToolNames = null;
  if (!asJson) console.log(`（预览工具清单失败：${err?.message ?? err}）`);
}

let live = states.filter((state) => state.alive);
const exited = states.length - live.length;
const reports = live.map((state) => {
  const clean = state.sourceHash === disk.hash;
  const toolDelta = diskToolNames && Array.isArray(state.toolNames)
    ? {
      added: diskToolNames.filter((n) => !state.toolNames.includes(n)),
      removed: state.toolNames.filter((n) => !diskToolNames.includes(n)),
    }
    : { added: [], removed: [] };
  return {
    pid: state.pid,
    startedAt: state.startedAt,
    heartbeatAgeMs: state.heartbeatAgeMs ?? null,
    sourceHash: state.sourceHash,
    toolCount: state.toolCount ?? null,
    fresh: clean,
    changedFiles: clean ? [] : diffFiles(disk, state),
    toolDelta,
  };
});

const stale = reports.filter((report) => !report.fresh);
const status = reports.length === 0 ? 2 : stale.length > 0 ? 1 : 0;

if (asJson) {
  console.log(JSON.stringify({ repoRoot: REPO_ROOT, git: gitSummary(), disk, instances: reports, status }, null, 2));
} else {
  const git = gitSummary();
  console.log(`仓库        ${REPO_ROOT}`);
  if (git.available) {
    console.log(`HEAD        ${git.head}`);
    console.log(`未提交       ${git.uncommittedFiles} 个文件${git.uncommittedFiles ? '（磁盘可能还在被改）' : ''}`);
  } else {
    console.log(`HEAD        ${git.note}`);
  }
  console.log(`磁盘源码     hash=${disk.hash}  ${disk.fileCount} 个 .mjs  最新改动 ${disk.newest.file}`);
  if (diskToolNames) console.log(`磁盘工具     ${diskToolNames.length} 个${diskToolNames.length ? `：${diskToolNames.join(', ')}` : ''}`);

  if (reports.length === 0) {
    console.log('');
    console.log('运行实例     ❔ 没找到活着的实例（.runtime/ 里没有心跳新鲜的指纹）');
    console.log(`             宿主可能还没拉起 MCP，或插件被停用；先确认连接再谈版本。${exited ? `（另有 ${exited} 个已退出的残留指纹，不影响判断）` : ''}`);
    console.log('             若 spine_doctor 能返回、但返回里没有 build 字段 → 实例早于本机制，直接按下面的步骤重载。');
  }

  for (const report of reports) {
    const mark = report.fresh ? '✅' : '❌';
    const started = String(report.startedAt).replace('T', ' ').replace(/\..*$/, '');
    const ageSec = Math.round((report.heartbeatAgeMs ?? 0) / 1000);
    console.log('');
    console.log(`运行实例     ${mark} pid=${report.pid}  启动=${started}Z  hash=${report.sourceHash}  工具 ${report.toolCount ?? '?'} 个  心跳 ${ageSec}s 前`);
    if (report.fresh) {
      console.log('             与磁盘一致，可以直接用。');
      continue;
    }
    console.log('             落后于磁盘，工具行为可能是旧版：');
    for (const line of report.changedFiles) console.log(`               · ${line}`);
    if (report.toolDelta.added.length) console.log(`               · 新增工具 ${report.toolDelta.added.join(', ')}（按旧版调用会 Method not found / 不出现）`);
    if (report.toolDelta.removed.length) console.log(`               · 已删工具 ${report.toolDelta.removed.join(', ')}（旧进程里还挂着）`);
  }

  console.log('');
  if (status === 0) {
    console.log('结论        当前运行实例就是最新代码。');
  } else if (status === 1) {
    console.log('结论        先重载 MCP 再用工具，别拿旧进程的结论当验证结果。');
    console.log('            DSH：plugin_manager set_plugin(include:mcp-spine, enabled:false) → 再 enabled:true；');
    console.log('                 或用界面上的「重新应用」；WorkBuddy 侧重连该 MCP 即可。');
  } else {
    console.log('结论        没有运行实例可比对；先确认宿主已连接（spine_doctor 可用即说明连上了）。');
  }
}

process.exit(status);
