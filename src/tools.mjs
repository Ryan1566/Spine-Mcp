import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertSafePath,
  assertWritableOutput,
  cleanArgs,
  exportArgs,
  importArgs,
  isSpineConfigured,
  resolveSpineExe,
  runSpine,
  SPINE_TARGET_VERSION,
} from './spine-cli.mjs';
import {
  buildCombatAnimation,
  frameTable,
  validateAnimation,
} from './timeline.mjs';
import { requestGuiReload, RELOAD_HINT } from './gui-link.mjs';
import { projectInfo } from './project-info.mjs';
import { makeExportSettings } from './export-settings.mjs';
import { backupIfExists } from './backup.mjs';
import { verifyExport } from './verify-export.mjs';
import { packArgs, unpackArgs } from './atlas.mjs';
import { restoreBackup } from './restore.mjs';
import { diffAnimations, mergeAnimations, manageEvents, buildBatch } from './animation-ops.mjs';
import { modifyBones } from './bone-ops.mjs';
import { editWeights } from './weight-ops.mjs';

// 写 JSON 副本（而非 .spine）的工具统一提示人工 Import Data，不自动重载工程。
const NEXT_STEP_IMPORT = '若要在 Spine 编辑器里查看，请手动 File → Import Data 导入这个 JSON 副本（不自动重载工程）。';

const frameRef = { type: 'integer', minimum: 1, description: '1-based 帧号' };
const eventFrameSchema = {
  type: 'object',
  properties: {
    frame: frameRef,
    name: { type: 'string', description: '事件名，如 hit / recover / footstep' },
    int: { type: 'number' },
    float: { type: 'number' },
    string: { type: 'string' },
  },
  required: ['frame', 'name'],
  additionalProperties: false,
};
const keyframeSchema = (extra) => ({
  type: 'object',
  properties: {
    frame: frameRef,
    ...extra,
    curve: { description: '可选，Spine 曲线：省略为线性，"stepped" 或贝塞尔数值数组' },
  },
  required: ['frame'],
  additionalProperties: false,
});
const boneControlSchema = {
  type: 'object',
  properties: {
    bone: { type: 'string', description: '必须存在于源 skeleton 的 bones' },
    rotate: { type: 'array', items: keyframeSchema({ angle: { type: 'number' } }) },
    translate: { type: 'array', items: keyframeSchema({ x: { type: 'number' }, y: { type: 'number' } }) },
    scale: { type: 'array', items: keyframeSchema({ x: { type: 'number' }, y: { type: 'number' } }) },
    shear: { type: 'array', items: keyframeSchema({ x: { type: 'number' }, y: { type: 'number' } }) },
  },
  required: ['bone'],
  additionalProperties: false,
};

export const TOOLS = [
  {
    name: 'spine_doctor',
    description: '检查本机 Spine 3.8.75 CLI 配置与环境。不修改任何文件。',
    inputSchema: {
      type: 'object',
      properties: {
        probe: { type: 'boolean', description: '为 true 时额外执行 Spine --help 验证 CLI 可用，默认 false' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'spine_inspect_json',
    description: '只读解析 Spine 导出的 skeleton JSON，列出骨骼/插槽/皮肤/动画/事件。',
    inputSchema: {
      type: 'object',
      properties: { jsonPath: { type: 'string', description: 'skeleton JSON 绝对路径' } },
      required: ['jsonPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_frames_to_seconds',
    description: '把「N 帧 @ fps」的战斗动画规格换算成 Spine 时间轴秒数与命中帧位置。',
    inputSchema: {
      type: 'object',
      properties: {
        fps: { type: 'integer', minimum: 1, description: '播放帧率，常规 12' },
        frames: { type: 'integer', minimum: 1, description: '总帧数，如普攻 8' },
        eventFrames: { type: 'array', items: eventFrameSchema, description: '事件帧，如 F3 命中' },
      },
      required: ['fps', 'frames'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_build_combat_animation',
    description: '在源 skeleton JSON 的副本上生成一条战斗动画（骨骼关键帧 + 事件帧 + 插槽换图），不修改源文件。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceJsonPath: { type: 'string', description: '源 skeleton JSON 绝对路径' },
        outputJsonPath: { type: 'string', description: '输出 JSON 绝对路径（新文件）' },
        animationName: { type: 'string', description: '动画名，如 attack_01' },
        fps: { type: 'integer', minimum: 1, description: '规格播放帧率，用于帧->秒换算' },
        frames: { type: 'integer', minimum: 1, description: '规格总帧数' },
        boneControls: { type: 'array', items: boneControlSchema },
        eventFrames: { type: 'array', items: eventFrameSchema },
        slotKeys: {
          type: 'array',
          description: '可选，插槽换图关键帧',
          items: {
            type: 'object',
            properties: {
              slot: { type: 'string' },
              frame: frameRef,
              attachment: { type: ['string', 'null'] },
            },
            required: ['slot', 'frame'],
            additionalProperties: false,
          },
        },
        overwrite: { type: 'boolean', description: '输出文件/同名动画已存在时是否覆盖，默认 false' },
      },
      required: ['sourceJsonPath', 'outputJsonPath', 'animationName', 'fps', 'frames'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_validate_timeline',
    description: '静态校验生成动画的时间轴：时间递增、骨骼存在、事件定义齐全。不调用 Spine。',
    inputSchema: {
      type: 'object',
      properties: {
        jsonPath: { type: 'string', description: '待校验的 skeleton JSON 绝对路径' },
        animationName: { type: 'string', description: '动画名' },
      },
      required: ['jsonPath', 'animationName'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_export',
    description: '调用官方 Spine CLI 导出工程。3.8.75 强制要求 -e 指向真实存在的导出设置 JSON。',
    inputSchema: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: '.spine 工程绝对路径' },
        outputDir: { type: 'string', description: '导出目录绝对路径' },
        exportSettingsPath: { type: 'string', description: '导出设置 JSON 绝对路径（必填，必须存在）' },
        clean: { type: 'boolean', description: '是否追加 -m 清理，默认 false' },
        backup: { type: 'boolean', description: 'clean:true 时写前备份源工程到系统临时目录，默认 true' },
        extraInputs: {
          type: 'array',
          description: '可选，追加多组 -i/-e 实现批量导出（3.8.75 已实测支持混合 JSON / Binary）',
          items: {
            type: 'object',
            properties: {
              inputPath: { type: 'string', description: '另一个工程或数据文件绝对路径' },
              exportSettingsPath: { type: 'string', description: '对应的导出设置 JSON 绝对路径' },
            },
            required: ['inputPath', 'exportSettingsPath'],
            additionalProperties: false,
          },
        },
      },
      required: ['inputPath', 'outputDir', 'exportSettingsPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_import_json',
    description: '调用官方 Spine CLI 把 JSON / binary / 另一个 .spine 工程的 skeleton 导入 .spine 工程（`-r`，工程输入已实测）。',
    inputSchema: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: '输入 JSON / skel 绝对路径' },
        outputPath: { type: 'string', description: '输出 .spine 绝对路径' },
        scale: { type: 'number', exclusiveMinimum: 0 },
        skeletonName: { type: 'string' },
        overwrite: { type: 'boolean', description: '输出已存在时是否覆盖，默认 false' },
        backup: { type: 'boolean', description: 'overwrite:true 时写前备份目标工程到系统临时目录，默认 true' },
      },
      required: ['inputPath', 'outputPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_clean',
    description: '调用官方 Spine CLI 清理工程动画（-m）。不删除用户文件。',
    inputSchema: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: '.spine 工程绝对路径' },
        backup: { type: 'boolean', description: '写前把源工程备份到系统临时目录，默认 true（实测 -m 会原地改写文件）' },
      },
      required: ['inputPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_reload_gui',
    description: '方案 C：CLI 改写工程后，请求 Spine GUI 重新打开该工程。走官方 Editor 模式（Spine.exe <工程路径>），不模拟鼠标键盘、不改动工程文件。Spine 3.8.75 有单实例锁：检测到已有 GUI 时默认阻止启动并返回可选做法；dryRun=true 只返回计划。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '要重新打开的 .spine 工程绝对路径（必须存在）' },
        dryRun: { type: 'boolean', description: '默认 false；true 时只返回将要执行的命令与参数，不启动 GUI' },
        allowWhenRunning: { type: 'boolean', description: '默认 false；已有 GUI 实例时仍强制尝试启动（通常会被单实例锁拒绝）' },
      },
      required: ['projectPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_project_info',
    description: '只读读取 .spine / 数据文件的工程信息（官方 CLI -i Info 模式），返回原始输出与结构化摘要。不修改文件。',
    inputSchema: {
      type: 'object',
      properties: { inputPath: { type: 'string', description: '工程或数据文件绝对路径（必须存在）' } },
      required: ['inputPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_version',
    description: '读取本机 Spine 启动器版本信息（官方 CLI --version）。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'spine_make_export_settings',
    description: '生成 3.8.75 导出设置 JSON（供 spine_export 的 -e 使用）。`json` / `binary` 均已在本机验证；图片 / 视频格式未验证，不开放。',
    inputSchema: {
      type: 'object',
      properties: {
        outputPath: { type: 'string', description: '设置文件输出绝对路径（新文件）' },
        outputDir: { type: 'string', description: '写入 settings.output；spine_export 的 -o 会覆盖它' },
        format: { type: 'string', enum: ['json', 'binary'], description: '导出格式；json 与 binary 均已在本机 3.8.75 验证，图片 / 视频未开放' },
        prettyPrint: { type: 'boolean', description: '默认 true' },
        nonessential: { type: 'boolean', description: '默认 true' },
        cleanUp: { type: 'boolean', description: '默认 false；true 会在导出时清理动画，勿对原件开启' },
        overwrite: { type: 'boolean', description: '输出已存在时是否覆盖，默认 false' },
      },
      required: ['outputPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_verify_export',
    description: '只读校验导出产物：用官方 -i Info 分别读取源工程与导出目录里的 .json 产物，比对每个 skeleton 的骨骼 / 插槽 / 动画列表。会多次启动 CLI，较慢。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '源 .spine 工程绝对路径（必须存在）' },
        exportDir: { type: 'string', description: '导出目录绝对路径（必须存在）' },
      },
      required: ['projectPath', 'exportDir'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_pack_atlas',
    description: '官方 CLI 图集打包（3.8.75 已实测）：`-i` 图片目录 `-o` 输出目录 `-p` 图集名或 pack.json，支持 `-j` 关联工程与 `-n` 图集名。',
    inputSchema: {
      type: 'object',
      properties: {
        inputDir: { type: 'string', description: '待打包图片目录绝对路径（必须存在）' },
        outputDir: { type: 'string', description: '输出目录绝对路径' },
        atlasName: { type: 'string', description: '图集名；未提供 packSettingsPath 时必填' },
        packSettingsPath: { type: 'string', description: '可选，pack settings JSON 绝对路径（必须存在）' },
        projectPaths: { type: 'array', items: { type: 'string' }, description: '可选，若干 -j 工程路径，用于判断 mesh 用到哪些图片' },
      },
      required: ['inputDir', 'outputDir'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_unpack_atlas',
    description: '官方 CLI 图集解包（3.8.75 已实测）：`-i` 图集页图片目录 `-o` 输出目录 `-c` atlas 文件。',
    inputSchema: {
      type: 'object',
      properties: {
        inputDir: { type: 'string', description: '图集页图片所在目录绝对路径（必须存在）' },
        outputDir: { type: 'string', description: '解包后的 PNG 输出目录绝对路径' },
        atlasPath: { type: 'string', description: '.atlas 文件绝对路径（必须存在）' },
      },
      required: ['inputDir', 'outputDir', 'atlasPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_restore_backup',
    description: '把写前备份（`backupPath`）恢复回目标 `.spine` 工程。会覆盖目标，必须显式 `overwrite:true`；恢复前自动再备份当前目标，成功后提示手动 Ctrl+O。',
    inputSchema: {
      type: 'object',
      properties: {
        backupPath: { type: 'string', description: '备份文件绝对路径（必须存在）' },
        targetPath: { type: 'string', description: '要恢复到的 .spine 工程绝对路径' },
        overwrite: { type: 'boolean', description: '目标已存在时必须为 true，默认 false' },
      },
      required: ['backupPath', 'targetPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_diff_animations',
    description: '只读对比两份 skeleton JSON 的动画与事件定义：新增 / 删除 / 修改 / 未变，附关键帧数与事件数。',
    inputSchema: {
      type: 'object',
      properties: {
        baseJsonPath: { type: 'string', description: '基准 skeleton JSON 绝对路径' },
        otherJsonPath: { type: 'string', description: '对照 skeleton JSON 绝对路径' },
      },
      required: ['baseJsonPath', 'otherJsonPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_merge_animations',
    description: '把 donor 的动画合并到 base 的副本（默认跳过同名，可 overwrite），自动补齐事件定义。只写 JSON 副本。',
    inputSchema: {
      type: 'object',
      properties: {
        baseJsonPath: { type: 'string', description: '基准 skeleton JSON 绝对路径' },
        donorJsonPath: { type: 'string', description: '提供动画的 skeleton JSON 绝对路径' },
        outputJsonPath: { type: 'string', description: '输出 JSON 绝对路径（新文件）' },
        animationNames: { type: 'array', items: { type: 'string' }, description: '可选，只合并指定动画；默认全部' },
        overwrite: { type: 'boolean', description: '同名动画是否覆盖，默认 false' },
      },
      required: ['baseJsonPath', 'donorJsonPath', 'outputJsonPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_manage_events',
    description: '事件定义独立管理：list（只读）/ add / remove / rename。list 不写文件，其余写 JSON 副本并提示人工 Import Data。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceJsonPath: { type: 'string', description: '源 skeleton JSON 绝对路径' },
        outputJsonPath: { type: 'string', description: 'list 模式可省略；其余模式必填' },
        mode: { type: 'string', enum: ['list', 'add', 'remove', 'rename'], description: '默认 list' },
        events: { type: 'array', items: {}, description: 'add / remove 时的事件列表：字符串或含 name 的定义对象' },
        rename: {
          type: 'object',
          properties: { from: { type: 'string' }, to: { type: 'string' } },
          required: ['from', 'to'],
          additionalProperties: false,
          description: 'rename 模式必填',
        },
        definitions: { type: 'object', description: '可选，add 时按事件名提供定义对象' },
        overwrite: { type: 'boolean', description: '输出已存在时是否覆盖，默认 false' },
      },
      required: ['sourceJsonPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_build_batch_animations',
    description: '多 skeleton 批量生成：对多个导出的 skeleton JSON 各生成一条同名动画副本，单个失败不影响其它。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceJsonPaths: { type: 'array', items: { type: 'string' }, description: '多个 skeleton JSON 绝对路径' },
        outputDir: { type: 'string', description: '输出目录绝对路径' },
        animationName: { type: 'string', description: '动画名' },
        fps: { type: 'integer', minimum: 1 },
        frames: { type: 'integer', minimum: 1 },
        boneControls: { type: 'array', items: boneControlSchema, description: '统一的骨骼关键帧（各 skeleton 骨骼名需一致）' },
        boneControlsBySkeleton: { type: 'object', description: '可选，按 skeleton 名分别指定 boneControls' },
        eventFrames: { type: 'array', items: eventFrameSchema },
        skipMissingBones: { type: 'boolean', description: '默认 false；true 时自动过滤各 skeleton 不存在的骨骼控制' },
        overwrite: { type: 'boolean', description: '输出文件已存在时是否覆盖，默认 false' },
      },
      required: ['sourceJsonPaths', 'outputDir', 'animationName', 'fps', 'frames'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_modify_bones',
    description: '在导出的 skeleton JSON 副本上修改骨骼：`list` 只读 / `add` / `remove` / `rename` / `reparent` / `set`（setup pose）。不写 `.spine`、不碰 GUI；含加权 mesh 的工程拒绝删除骨骼。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceJsonPath: { type: 'string', description: '源 skeleton JSON 绝对路径' },
        outputJsonPath: { type: 'string', description: 'list 模式可省略；其余模式必填' },
        mode: { type: 'string', enum: ['list', 'add', 'remove', 'rename', 'reparent', 'set'], description: '默认 list' },
        bones: { type: 'array', items: {}, description: 'add: 骨骼定义数组；remove: 骨骼名数组；set: { name, ...字段 } 数组' },
        rename: {
          type: 'object',
          properties: { from: { type: 'string' }, to: { type: 'string' } },
          required: ['from', 'to'],
          additionalProperties: false,
        },
        reparent: {
          type: 'object',
          properties: { name: { type: 'string' }, parent: { type: 'string' } },
          required: ['name', 'parent'],
          additionalProperties: false,
        },
        reparentChildren: { type: 'boolean', description: 'remove 时自动把子骨骼接到被删骨骼的父级，默认 false' },
        dropAnimationTracks: { type: 'boolean', description: 'remove 时自动删除引用该骨骼的动画时间轴，默认 false' },
        overwrite: { type: 'boolean', description: '输出已存在时是否覆盖，默认 false' },
      },
      required: ['sourceJsonPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_edit_weights',
    description: '3.8.75 网格权重数值层：`inspect` 只读校验（权重和 / 骨骼下标 / 每骨骼权重汇总）、`normalize` 归一化、`scale` 按骨骼批量缩放后归一化。只写 JSON 副本，不改顶点坐标与骨骼归属。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceJsonPath: { type: 'string', description: '源 skeleton JSON 绝对路径' },
        outputJsonPath: { type: 'string', description: 'inspect 模式可省略；其余模式必填' },
        mode: { type: 'string', enum: ['inspect', 'normalize', 'scale'], description: '默认 inspect' },
        bone: { type: ['string', 'integer'], description: 'scale 模式必填：骨骼名或全局下标' },
        factor: { type: 'number', exclusiveMinimum: 0, description: 'scale 模式的权重倍率，如 0.8 / 1.2' },
        overwrite: { type: 'boolean', description: '输出已存在时是否覆盖，默认 false' },
      },
      required: ['sourceJsonPath'],
      additionalProperties: false,
    },
  },
];

function readJson(jsonPath) {
  assertSafePath(jsonPath, 'jsonPath', { mustExist: true });
  return fs.readFile(jsonPath, 'utf8').then((text) => {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`JSON 解析失败: ${jsonPath} -> ${err.message}`);
    }
  });
}

function summarizeSkeleton(skeleton, jsonPath) {
  const names = (arr) => (Array.isArray(arr) ? arr.map((x) => x?.name ?? x).filter(Boolean).slice(0, 40) : []);
  return {
    jsonPath,
    spineVersion: skeleton?.skeleton?.spine ?? '(未标注)',
    hash: skeleton?.skeleton?.hash ?? null,
    counts: {
      bones: (skeleton.bones ?? []).length,
      slots: (skeleton.slots ?? []).length,
      skins: Array.isArray(skeleton.skins) ? skeleton.skins.length : Object.keys(skeleton.skins ?? {}).length,
      animations: Object.keys(skeleton.animations ?? {}).length,
      events: Object.keys(skeleton.events ?? {}).length,
    },
    bones: names(skeleton.bones),
    slots: names(skeleton.slots),
    animations: Object.keys(skeleton.animations ?? {}).slice(0, 40),
    events: Object.keys(skeleton.events ?? {}).slice(0, 40),
  };
}

// 会写 .spine 的操作统一附带人工重载提示；只在成功时加，失败不误导。
export function withReloadHint(result) {
  return result?.success ? { ...result, requiresManualReload: true, reloadHint: RELOAD_HINT } : result;
}

// 写前备份的路径随结果返回，方便用户恢复；没备份就不加字段。
function withBackup(result, backupPath) {
  if (!backupPath) return result;
  return { ...result, backupPath, backupHint: '已写前备份到系统临时目录；如需恢复请手动复制回去。' };
}

export async function callTool(name, args = {}) {
  switch (name) {
    case 'spine_doctor': {
      const exe = resolveSpineExe();
      const configured = isSpineConfigured();
      const result = {
        serverVersion: '0.1.0',
        targetSpineVersion: SPINE_TARGET_VERSION,
        nodeVersion: process.version,
        platform: process.platform,
        spineExe: exe,
        spineConfigured: configured,
        protocolVersions: { modern: ['2026-07-28'], legacy: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] },
        toolCount: TOOLS.length,
        hints: [
          configured ? 'SPINE_EXE 已指向一个存在的可执行文件' : '尚未配置 SPINE_EXE，涉及 CLI 的工具会失败；纯逻辑工具仍可用',
          '3.8.75 导出必须提供真实存在的 exportSettingsPath',
        ],
      };
      if (args.probe === true && configured) {
        result.probe = await runSpine(['--help'], { timeoutMs: 20000 });
      }
      return result;
    }

    case 'spine_inspect_json': {
      const skeleton = await readJson(args.jsonPath);
      return summarizeSkeleton(skeleton, args.jsonPath);
    }

    case 'spine_frames_to_seconds': {
      return frameTable(args.frames, args.fps, args.eventFrames ?? []);
    }

    case 'spine_build_combat_animation': {
      const skeleton = await readJson(args.sourceJsonPath);
      const { json, summary } = buildCombatAnimation(skeleton, {
        animationName: args.animationName,
        fps: args.fps,
        frames: args.frames,
        boneControls: args.boneControls ?? [],
        eventFrames: args.eventFrames ?? [],
        slotKeys: args.slotKeys ?? [],
        overwrite: args.overwrite === true,
      });
      const outputPath = assertWritableOutput(args.outputJsonPath, 'outputJsonPath', args.overwrite === true);
      await fs.writeFile(outputPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
      return { writtenTo: outputPath, sourceUnchanged: true, nextStep: NEXT_STEP_IMPORT, ...summary };
    }

    case 'spine_validate_timeline': {
      const skeleton = await readJson(args.jsonPath);
      return validateAnimation(skeleton, args.animationName);
    }

    case 'spine_export': {
      const cliArgs = exportArgs({
        inputPath: args.inputPath,
        outputDir: args.outputDir,
        exportSettingsPath: args.exportSettingsPath,
        clean: args.clean === true,
        extraInputs: args.extraInputs ?? [],
      });
      const cleaning = args.clean === true;
      const backupPath = backupIfExists(args.inputPath, cleaning && args.backup !== false);
      const result = await runSpine(cliArgs);
      // clean:true 会追加 -m，可能改动源工程，此时必须提示人工重载。
      return withBackup(cleaning ? withReloadHint(result) : result, backupPath);
    }

    case 'spine_import_json': {
      const cliArgs = importArgs({
        inputPath: args.inputPath,
        outputPath: args.outputPath,
        scale: args.scale,
        skeletonName: args.skeletonName,
      });
      assertWritableOutput(args.outputPath, 'outputPath', args.overwrite === true);
      const backupPath = backupIfExists(args.outputPath, args.overwrite === true && args.backup !== false);
      return withBackup(withReloadHint(await runSpine(cliArgs)), backupPath);
    }

    case 'spine_clean': {
      const backupPath = backupIfExists(args.inputPath, args.backup !== false);
      return withBackup(withReloadHint(await runSpine(cleanArgs({ inputPath: args.inputPath }))), backupPath);
    }

    case 'spine_reload_gui': {
      return requestGuiReload({
        projectPath: args.projectPath,
        dryRun: args.dryRun === true,
        allowWhenRunning: args.allowWhenRunning === true,
      });
    }

    case 'spine_project_info': {
      return projectInfo(args.inputPath);
    }

    case 'spine_version': {
      return runSpine(['--version'], { timeoutMs: 20000 });
    }

    case 'spine_make_export_settings': {
      return makeExportSettings({
        outputPath: args.outputPath,
        outputDir: args.outputDir,
        format: args.format,
        prettyPrint: args.prettyPrint,
        nonessential: args.nonessential,
        cleanUp: args.cleanUp,
        overwrite: args.overwrite === true,
      });
    }

    case 'spine_verify_export': {
      return verifyExport({ projectPath: args.projectPath, exportDir: args.exportDir });
    }

    case 'spine_pack_atlas': {
      return runSpine(packArgs({
        inputDir: args.inputDir,
        outputDir: args.outputDir,
        atlasName: args.atlasName,
        packSettingsPath: args.packSettingsPath,
        projectPaths: args.projectPaths ?? [],
      }));
    }

    case 'spine_unpack_atlas': {
      return runSpine(unpackArgs({
        inputDir: args.inputDir,
        outputDir: args.outputDir,
        atlasPath: args.atlasPath,
      }));
    }

    case 'spine_restore_backup': {
      return restoreBackup({
        backupPath: args.backupPath,
        targetPath: args.targetPath,
        overwrite: args.overwrite === true,
      });
    }

    case 'spine_diff_animations': {
      const base = await readJson(args.baseJsonPath);
      const other = await readJson(args.otherJsonPath);
      return diffAnimations(base, other);
    }

    case 'spine_merge_animations': {
      const base = await readJson(args.baseJsonPath);
      const donor = await readJson(args.donorJsonPath);
      const { json, summary } = mergeAnimations(base, donor, {
        animationNames: args.animationNames,
        overwrite: args.overwrite === true,
      });
      const outputPath = assertWritableOutput(args.outputJsonPath, 'outputJsonPath', args.overwrite === true);
      await fs.writeFile(outputPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
      return { writtenTo: outputPath, sourceUnchanged: true, nextStep: NEXT_STEP_IMPORT, ...summary };
    }

    case 'spine_manage_events': {
      const skeleton = await readJson(args.sourceJsonPath);
      const mode = args.mode ?? 'list';
      const { json, summary, events } = manageEvents(skeleton, {
        mode,
        events: args.events ?? [],
        rename: args.rename,
        definitions: args.definitions ?? {},
      });
      if (mode === 'list') return { sourceJsonPath: args.sourceJsonPath, events };
      if (!args.outputJsonPath) throw new Error('非 list 模式必须提供 outputJsonPath');
      const outputPath = assertWritableOutput(args.outputJsonPath, 'outputJsonPath', args.overwrite === true);
      await fs.writeFile(outputPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
      return { writtenTo: outputPath, sourceUnchanged: true, nextStep: NEXT_STEP_IMPORT, ...summary };
    }

    case 'spine_build_batch_animations': {
      const paths = args.sourceJsonPaths;
      if (!Array.isArray(paths) || paths.length === 0) throw new Error('sourceJsonPaths 必须是非空数组');
      const items = [];
      for (const filePath of paths) {
        const skeleton = await readJson(filePath);
        items.push({ name: path.basename(filePath, '.json'), skeleton });
      }
      const { results, failures } = buildBatch(items, {
        animationName: args.animationName,
        fps: args.fps,
        frames: args.frames,
        boneControls: args.boneControls ?? [],
        boneControlsBySkeleton: args.boneControlsBySkeleton,
        eventFrames: args.eventFrames ?? [],
        skipMissingBones: args.skipMissingBones === true,
        overwrite: args.overwrite === true,
      });
      const written = [];
      for (const item of results) {
        const out = assertWritableOutput(
          path.join(args.outputDir, `${item.name}.${args.animationName}.json`),
          'outputJsonPath',
          args.overwrite === true,
        );
        await fs.writeFile(out, `${JSON.stringify(item.json, null, 2)}\n`, 'utf8');
        written.push({ file: out, skeleton: item.name, ...item.summary });
      }
      return { outputDir: args.outputDir, written, failures, nextStep: NEXT_STEP_IMPORT };
    }

    case 'spine_modify_bones': {
      const skeleton = await readJson(args.sourceJsonPath);
      const mode = args.mode ?? 'list';
      const { json, summary, bones } = modifyBones(skeleton, {
        mode,
        bones: args.bones ?? [],
        rename: args.rename,
        reparent: args.reparent,
        reparentChildren: args.reparentChildren === true,
        dropAnimationTracks: args.dropAnimationTracks === true,
      });
      if (mode === 'list') return { sourceJsonPath: args.sourceJsonPath, bones };
      if (!args.outputJsonPath) throw new Error('非 list 模式必须提供 outputJsonPath');
      const outputPath = assertWritableOutput(args.outputJsonPath, 'outputJsonPath', args.overwrite === true);
      await fs.writeFile(outputPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
      return { writtenTo: outputPath, sourceUnchanged: true, nextStep: NEXT_STEP_IMPORT, ...summary };
    }

    case 'spine_edit_weights': {
      const skeleton = await readJson(args.sourceJsonPath);
      const mode = args.mode ?? 'inspect';
      const { report, json, summary } = editWeights(skeleton, {
        mode,
        bone: args.bone,
        factor: args.factor,
      });
      if (mode === 'inspect') return { sourceJsonPath: args.sourceJsonPath, ...report };
      if (!args.outputJsonPath) throw new Error('非 inspect 模式必须提供 outputJsonPath');
      const outputPath = assertWritableOutput(args.outputJsonPath, 'outputJsonPath', args.overwrite === true);
      await fs.writeFile(outputPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
      return { writtenTo: outputPath, sourceUnchanged: true, nextStep: NEXT_STEP_IMPORT, ...summary };
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}
