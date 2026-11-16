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
import { makeExportSettings, readExportClass, isRenderClass, formatForRenderClass } from './export-settings.mjs';
import { collectRenderOutputs } from './render-outputs.mjs';
import { backupIfExists, listBackups } from './backup.mjs';
import { verifyExport } from './verify-export.mjs';
import { parseSkelFile } from './skel-parse.mjs';
import { assertDirectory, packArgs, unpackArgs } from './atlas.mjs';
import { restoreBackup } from './restore.mjs';
import { diffAnimations, mergeAnimations, manageEvents, buildBatch } from './animation-ops.mjs';
import { modifyBones } from './bone-ops.mjs';
import { editWeights } from './weight-ops.mjs';
import { auditProject } from './project-audit.mjs';
import { inspectAnimation, editAnimation } from './animation-detail.mjs';
import { modifySlots, modifySkins, inspectConstraints, modifyConstraints } from './structure-ops.mjs';
import { inspectAtlas, auditAssets } from './asset-audit.mjs';
import { writeJsonCopy } from './write-safety.mjs';
import { runExportWorkflow } from './export-workflow.mjs';

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
    name: 'spine_inspect_skel',
    description: '只读解析 Spine 二进制 .skel：按 SkeletonBinary 顺序逐字段读到文件末尾，回传头部信息、骨骼/插槽/约束/皮肤/附件/事件/动画结构，并做引用完整性检查。consumedBytes 必须等于文件长度，否则说明结构读分叉。不调用 CLI，不修改文件。',
    inputSchema: {
      type: 'object',
      properties: {
        skelPath: { type: 'string', description: '.skel 二进制文件绝对路径（必须存在）' },
        detail: { type: 'boolean', description: '为 true 时额外回传完整骨骼 / 插槽 / 约束明细，默认只给计数与动画时长' },
      },
      required: ['skelPath'],
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
        dryRun: { type: 'boolean', description: 'true 时只预览将写入的文件与变更摘要，不写文件' },
        backup: { type: 'boolean', description: 'overwrite 覆盖旧输出前是否备份，默认 true' },
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
    description: '调用官方 Spine CLI 导出工程。3.8.75 强制要求 -e 指向真实存在的导出设置 JSON。数据导出（export-json / export-binary）的 -o 是目录；渲染导出（export-png / export-mov / export-avi / export-gif）的 -o 是文件基名，扩展名由设置 class 决定，渲染导出会自动回传实际产出的文件清单。',
    inputSchema: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: '.spine 工程绝对路径' },
        outputDir: { type: 'string', description: '输出路径：数据导出填目录；渲染导出填文件基名（不要带后缀，如 D:/out/raptor）' },
        exportSettingsPath: { type: 'string', description: '导出设置 JSON 绝对路径（必填，必须存在）' },
        clean: { type: 'boolean', description: '是否追加 -m 清理，默认 false' },
        backup: { type: 'boolean', description: 'clean:true 时写前备份源工程到系统临时目录，默认 true' },
        timeoutMs: { type: 'number', description: '可选，CLI 超时毫秒数；默认 120000，渲染导出建议放宽到 600000' },
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
    description: '生成 3.8.75 导出设置 JSON（供 spine_export 的 -e 使用）。数据导出 json / binary 与渲染导出 png / mov / avi / gif 均已在本机 3.8.75 真实导出验证。',
    inputSchema: {
      type: 'object',
      properties: {
        outputPath: { type: 'string', description: '设置文件输出绝对路径（新文件）' },
        outputDir: { type: 'string', description: '写入 settings.output；仅 json / binary 有意义（spine_export 的 -o 会覆盖它）' },
        format: { type: 'string', enum: ['json', 'binary', 'png', 'mov', 'avi', 'gif'], description: '导出格式；png / mov / avi / gif 为渲染导出，-o 会被当成文件基名' },
        prettyPrint: { type: 'boolean', description: '默认 true；仅 json / binary' },
        nonessential: { type: 'boolean', description: '默认 true；仅 json / binary' },
        cleanUp: { type: 'boolean', description: '默认 false；true 会在导出时清理动画，勿对原件开启（仅 json / binary）' },
        animationType: { type: 'string', enum: ['all', 'single', 'current'], description: '渲染导出用：all 逐动画逐帧，single / current 只出单张；png + all 时 -o 会被当目录' },
        lastFrame: { type: 'boolean', description: '渲染导出用：true 时输出动画的每一帧（实测 raptor 的 png 由 8 张变 13 张）' },
        msaa: { type: 'number', description: '渲染导出用：多重采样，实测 4 可用，0 表示关闭' },
        backgroundColor: { type: 'string', description: '渲染导出用：#RRGGBB 或 #RRGGBBAA，会转成 CLI 要求的 {r,g,b,a} 对象' },
        overwrite: { type: 'boolean', description: '输出已存在时是否覆盖，默认 false' },
      },
      required: ['outputPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_verify_export',
    description: '只读校验导出产物：源工程用官方 -i Info 读取；产物中 .json 同样走 -i Info，.skel 走本地二进制解析（不依赖 CLI）。比对每个 skeleton 的骨骼 / 插槽 / 动画 / IK 名称集合，并回传二进制结构自检结果。会多次启动 CLI，较慢。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '源 .spine 工程绝对路径（必须存在）' },
        exportDir: { type: 'string', description: '导出目录绝对路径（必须存在）' },
        includeBinary: { type: 'boolean', description: '是否同时解析 .skel 产物，默认 true' },
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
        boneMap: { type: 'object', description: '可选，donor 骨骼名到 base 骨骼名的映射，如 {"arm":"upper_arm"}', additionalProperties: { type: 'string' } },
        timeOffset: { type: 'number', description: '可选，合并动画的所有关键帧统一平移的秒数，默认 0；不得产生负 time' },
        skipMissingBones: { type: 'boolean', description: '默认 false；true 时丢弃映射后仍不存在于 base 的骨骼轨道并记录报告' },
        overwrite: { type: 'boolean', description: '同名动画是否覆盖，默认 false' },
        dryRun: { type: 'boolean', description: 'true 时只预览输出与变更摘要，不写文件' },
        backup: { type: 'boolean', description: 'overwrite 覆盖旧输出前是否备份，默认 true' },
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
        dryRun: { type: 'boolean', description: 'true 时只预览输出与变更摘要，不写文件' },
        backup: { type: 'boolean', description: 'overwrite 覆盖旧输出前是否备份，默认 true' },
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
        dryRun: { type: 'boolean', description: 'true 时只预览各输出与变更摘要，不写文件' },
        backup: { type: 'boolean', description: 'overwrite 覆盖旧输出前是否备份，默认 true' },
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
        dryRun: { type: 'boolean', description: 'true 时只预览输出与变更摘要，不写文件' },
        backup: { type: 'boolean', description: 'overwrite 覆盖旧输出前是否备份，默认 true' },
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
        dryRun: { type: 'boolean', description: 'true 时只预览输出与变更摘要，不写文件' },
        backup: { type: 'boolean', description: 'overwrite 覆盖旧输出前是否备份，默认 true' },
      },
      required: ['sourceJsonPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_audit_project',
    description: '只读体检 skeleton JSON：骨骼/插槽/附件/网格/权重引用与结构、全部动画时间轴和事件定义。返回 errors/warnings 与定位信息，不写文件、不调用 Spine。',
    inputSchema: {
      type: 'object',
      properties: { jsonPath: { type: 'string', description: 'skeleton JSON 绝对路径' } },
      required: ['jsonPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_inspect_animation',
    description: '只读查看一条动画的完整时间轴明细：bones/slots/IK/transform/path/deform/events/drawOrder，包含关键帧、曲线类型、起止时间与总时长。可限制关键帧返回数量。',
    inputSchema: {
      type: 'object',
      properties: {
        jsonPath: { type: 'string', description: 'skeleton JSON 绝对路径' },
        animationName: { type: 'string', description: '动画名' },
        includeKeyframes: { type: 'boolean', description: '是否返回关键帧内容，默认 true；false 只返回摘要' },
        maxKeyframes: { type: 'integer', minimum: 1, description: '最多返回的关键帧总数，默认 1000；原始统计不受截断影响' },
      },
      required: ['jsonPath', 'animationName'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_edit_animation',
    description: '在 JSON 副本上编辑一条动画：duplicate / rename / remove / shift（秒）/ scale（时长倍率）/ crop（时间区间）。覆盖所有时间轴类型；crop 不自动补边界插值帧。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceJsonPath: { type: 'string', description: '源 skeleton JSON 绝对路径' },
        outputJsonPath: { type: 'string', description: '输出 JSON 副本绝对路径' },
        animationName: { type: 'string', description: '要编辑的动画名' },
        mode: { type: 'string', enum: ['duplicate', 'rename', 'remove', 'shift', 'scale', 'crop'] },
        newName: { type: 'string', description: 'duplicate / rename 模式必填' },
        offset: { type: 'number', description: 'shift 模式必填，单位秒，可为负数但不能产生负 time' },
        scale: { type: 'number', exclusiveMinimum: 0, description: 'scale 模式必填，如 0.5 加速一倍、2 延长一倍' },
        start: { type: 'number', minimum: 0, description: 'crop 模式必填，区间起点秒（含）' },
        end: { type: 'number', exclusiveMinimum: 0, description: 'crop 模式必填，区间终点秒（含）' },
        overwrite: { type: 'boolean', description: '输出已存在时是否覆盖，默认 false' },
        dryRun: { type: 'boolean', description: 'true 时只预览输出与变更摘要，不写文件' },
        backup: { type: 'boolean', description: 'overwrite 覆盖旧输出前是否备份，默认 true' },
      },
      required: ['sourceJsonPath', 'outputJsonPath', 'animationName', 'mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_edit_slots',
    description: '在 JSON 副本上修改插槽：`list` 只读 / `add` / `remove`（引用保护）/ `rename`（同步皮肤与动画）/ `set`（bone/attachment/color/dark/blend）/ `reorder`（draw order）。不写 `.spine`。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceJsonPath: { type: 'string', description: '源 skeleton JSON 绝对路径' },
        outputJsonPath: { type: 'string', description: 'list 模式可省略；其余模式必填' },
        mode: { type: 'string', enum: ['list', 'add', 'remove', 'rename', 'set', 'reorder'], description: '默认 list' },
        slots: {
          type: 'array',
          description: 'add: { name, bone, ...字段 }；remove: 插槽名或对象；set: { name, ...字段 }',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              bone: { type: 'string' },
              attachment: { type: ['string', 'null'] },
              color: { type: 'string' },
              dark: { type: 'string' },
              blend: { type: 'string' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        rename: {
          type: 'object',
          properties: { from: { type: 'string' }, to: { type: 'string' } },
          required: ['from', 'to'],
          additionalProperties: false,
        },
        order: { type: 'array', items: { type: 'string' }, description: 'reorder 模式必填：全部插槽名的新顺序，不得遗漏或重复' },
        dropAttachments: { type: 'boolean', description: 'remove 时是否一并删除皮肤里该插槽的附件，默认 false' },
        dropAnimationTracks: { type: 'boolean', description: 'remove 时是否清理 slots/deform/drawOrder 引用，默认 false' },
        overwrite: { type: 'boolean', description: '输出已存在时是否覆盖，默认 false' },
        dryRun: { type: 'boolean', description: 'true 时只预览输出与变更摘要，不写文件' },
        backup: { type: 'boolean', description: 'overwrite 覆盖旧输出前是否备份，默认 true' },
      },
      required: ['sourceJsonPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_edit_skins',
    description: '在 JSON 副本上修改皮肤与附件分配：`list` 只读 / `add` / `remove`（deform 引用保护）/ `rename` / `assign`（按插槽设置或删除附件）。不写 `.spine`。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceJsonPath: { type: 'string', description: '源 skeleton JSON 绝对路径' },
        outputJsonPath: { type: 'string', description: 'list 模式可省略；其余模式必填' },
        mode: { type: 'string', enum: ['list', 'add', 'remove', 'rename', 'assign'], description: '默认 list' },
        skins: { type: 'array', items: { type: 'string' }, description: 'add / remove 的皮肤名数组；add 可传字符串' },
        rename: {
          type: 'object',
          properties: { from: { type: 'string' }, to: { type: 'string' } },
          required: ['from', 'to'],
          additionalProperties: false,
        },
        attachments: {
          type: 'array',
          description: 'assign 模式：按 { skin, slot, name, attachment } 设置附件；attachment 传 null 表示删除',
          items: {
            type: 'object',
            properties: {
              skin: { type: 'string' },
              slot: { type: 'string' },
              name: { type: 'string' },
              attachment: { type: 'object', description: '3.8.75 附件对象（region / mesh / linkedmesh 等）' },
            },
            required: ['skin', 'slot', 'name', 'attachment'],
            additionalProperties: false,
          },
        },
        dropDeformTracks: { type: 'boolean', description: 'remove 时是否清理对应 deform 动画轨道，默认 false' },
        overwrite: { type: 'boolean', description: '输出已存在时是否覆盖，默认 false' },
        dryRun: { type: 'boolean', description: 'true 时只预览输出与变更摘要，不写文件' },
        backup: { type: 'boolean', description: 'overwrite 覆盖旧输出前是否备份，默认 true' },
      },
      required: ['sourceJsonPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_inspect_constraints',
    description: '只读检查 IK / transform / path 约束：定义、骨骼引用、缺失骨骼与被哪些动画时间轴使用。不写文件。',
    inputSchema: {
      type: 'object',
      properties: { jsonPath: { type: 'string', description: 'skeleton JSON 绝对路径' } },
      required: ['jsonPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_edit_constraints',
    description: '在 JSON 副本上受控修改 IK / transform / path 约束：list / add / remove / rename / set。改名会同步动画轨道键名，删除前检查动画引用，字段按 3.8.75 官方白名单校验。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceJsonPath: { type: 'string', description: '源 skeleton JSON 绝对路径（只读）' },
        outputJsonPath: { type: 'string', description: '输出 JSON 绝对路径（非 list 模式必填）' },
        mode: { type: 'string', enum: ['list', 'add', 'remove', 'rename', 'set'], description: '默认 list（只读）' },
        type: { type: 'string', enum: ['ik', 'transform', 'path'], description: 'list 可省略（返回三类），写操作必填' },
        name: { type: 'string', description: 'remove / rename / set 的目标约束名' },
        newName: { type: 'string', description: 'rename 的新约束名' },
        constraint: { type: 'object', description: 'add / set 的字段：ik 支持 order/bones/target/mix/bendPositive；transform 另有 skin/x/y/rotation/scaleX/scaleY/shearX/shearY/rotateMix/translateMix/scaleMix/shearMix；path 另有 positionMode/spacingMode/rotateMode/rotation/position/spacing/rotateMix/translateMix', additionalProperties: true },
        dropAnimationTracks: { type: 'boolean', description: 'remove 时清掉引用该约束的动画轨道，默认 false（存在引用即拒绝删除）' },
        overwrite: { type: 'boolean', description: '输出已存在时是否覆盖，默认 false' },
        dryRun: { type: 'boolean', description: '只返回变更摘要与将要写入的内容，不落盘' },
        backup: { type: 'boolean', description: '覆盖旧输出前备份，默认 true' },
      },
      required: ['sourceJsonPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_inspect_atlas',
    description: '只读解析 .atlas 文件：页面、region 矩形、重名、越界、重叠与页图片存在性。不解码图片、不写文件。',
    inputSchema: {
      type: 'object',
      properties: {
        atlasPath: { type: 'string', description: '.atlas 文件绝对路径' },
        imageDir: { type: 'string', description: '可选，页图片所在目录；默认取 atlas 文件所在目录' },
      },
      required: ['atlasPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_audit_assets',
    description: '只读审计 skeleton 附件与图集 / 散图的对应关系：setup 与动画引用的附件、图集缺失 region、未被引用的 region、图片文件存在性。不写文件。',
    inputSchema: {
      type: 'object',
      properties: {
        jsonPath: { type: 'string', description: 'skeleton JSON 绝对路径' },
        atlasPaths: { type: 'array', items: { type: 'string' }, description: '可选，一个或多个 .atlas 文件绝对路径' },
        imageDir: { type: 'string', description: '可选，散图目录；不提供则跳过散图存在性检查' },
      },
      required: ['jsonPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_export_workflow',
    description: '批量导出工作流：多工程 × 多格式矩阵，自动生成已验证的 json / binary 导出设置（临时目录，默认用后删除），逐 job 调用 CLI 并回传统一产物报告（文件、大小、按格式汇总）与可选校验。支持 dryRun；不开启 cleanUp，不改源工程。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '主 .spine 工程绝对路径（与 projects 至少给一个）' },
        projects: { type: 'array', description: '可选，额外工程列表，与 projectPath 组成多工程矩阵；多工程时每个工程在 outputDir 下单独子目录', items: { type: 'string' } },
        outputDir: { type: 'string', description: '导出输出目录绝对路径' },
        format: { type: 'string', enum: ['json', 'binary'], description: '主工程导出格式，默认 json；图片 / 视频请用 spine_export' },
        formats: { type: 'array', description: '可选，多格式矩阵（每个工程 × 每个格式各一个 job），给出后忽略 format', items: { type: 'string', enum: ['json', 'binary'] } },
        exportSettingsPath: { type: 'string', description: '可选，已有导出设置 JSON；仅单 job 可用，多 job 请放 extraInputs' },
        extraInputs: {
          type: 'array',
          description: '可选，追加批量导出输入；同一工程可重复出现以导出多种格式',
          items: {
            type: 'object',
            properties: {
              inputPath: { type: 'string', description: '工程或数据文件绝对路径' },
              format: { type: 'string', enum: ['json', 'binary'], description: '默认沿用主 format' },
              exportSettingsPath: { type: 'string', description: '可选，已有导出设置 JSON' },
            },
            required: ['inputPath'],
            additionalProperties: false,
          },
        },
        prettyPrint: { type: 'boolean', description: '生成 JSON 设置时是否 prettyPrint，默认 true' },
        nonessential: { type: 'boolean', description: '生成设置时是否包含 nonessential，默认 true' },
        verify: { type: 'boolean', description: '导出成功后是否用官方 -i Info 校验产物，默认 false' },
        pack: {
          type: 'object',
          description: '可选，数据导出成功后打包图集（-i 图片目录 -j 工程 -o 输出 -p 设置或图集名），一次拿到 json/skel + atlas + png',
          properties: {
            imageDir: { type: 'string', description: '散图目录绝对路径（必填，必须存在）' },
            name: { type: 'string', description: '图集名；未提供 settingsPath 时必填' },
            settingsPath: { type: 'string', description: '可选，图集打包设置 JSON（官方 atlas-*.json）' },
            projectPaths: { type: 'array', description: '可选，多个 -j 工程路径，用于判断哪些图片被用到', items: { type: 'string' } },
            outputDir: { type: 'string', description: '可选，图集输出目录；默认沿用 outputDir，多工程时必填' },
          },
          required: ['imageDir'],
          additionalProperties: false,
        },
        dryRun: { type: 'boolean', description: 'true 时只返回计划，不建目录、不写设置、不调用 CLI' },
      },
      required: ['outputDir'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_list_backups',
    description: '只读列出系统临时目录 spine-mcp-backups 下的写前备份：文件、疑似原目标、大小、时间，按时间倒序。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, description: '最多返回条数，默认 100' } },
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

    case 'spine_inspect_skel': {
      const parsed = await parseSkelFile(args.skelPath);
      if (args.detail === true) return parsed;
      return {
        file: parsed.file,
        ok: parsed.ok,
        bytes: parsed.bytes,
        consumedBytes: parsed.consumedBytes,
        trailingBytes: parsed.trailingBytes,
        header: parsed.header,
        stringCount: parsed.stringCount,
        counts: parsed.counts,
        skins: parsed.skins,
        events: parsed.events,
        animations: parsed.animations,
        issues: parsed.issues,
        errorCount: parsed.errorCount,
        warningCount: parsed.warningCount,
      };
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
      const written = await writeJsonCopy({
        sourceSkeleton: skeleton,
        outputJsonPath: args.outputJsonPath,
        json,
        overwrite: args.overwrite === true,
        dryRun: args.dryRun === true,
        backup: args.backup !== false,
      });
      return { ...written, ...(written.dryRun ? {} : { nextStep: NEXT_STEP_IMPORT }), ...summary };
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
      // 渲染导出要靠 mtime 认本次产物，必须在启动 CLI 之前取时间点。
      const startedAt = Date.now();
      const settingsClass = await readExportClass(args.exportSettingsPath).catch(() => null);
      const renderFormat = isRenderClass(settingsClass) ? formatForRenderClass(settingsClass) : null;
      const cleaning = args.clean === true;
      const backupPath = backupIfExists(args.inputPath, cleaning && args.backup !== false);
      const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
        ? args.timeoutMs
        : (renderFormat ? 600000 : 120000);
      const result = await runSpine(cliArgs, { timeoutMs });
      const withOutputs = result.success && renderFormat
        ? {
          ...result,
          renderFormat,
          ...(await collectRenderOutputs({ outputPath: args.outputDir, format: renderFormat, startedAt })),
        }
        : result;
      // clean:true 会追加 -m，可能改动源工程，此时必须提示人工重载。
      return withBackup(cleaning ? withReloadHint(withOutputs) : withOutputs, backupPath);
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
        animationType: args.animationType,
        lastFrame: args.lastFrame,
        msaa: args.msaa,
        backgroundColor: args.backgroundColor,
        overwrite: args.overwrite === true,
      });
    }

    case 'spine_verify_export': {
      return verifyExport({ projectPath: args.projectPath, exportDir: args.exportDir, includeBinary: args.includeBinary !== false });
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
        boneMap: args.boneMap ?? {},
        timeOffset: args.timeOffset ?? 0,
        skipMissingBones: args.skipMissingBones === true,
        overwrite: args.overwrite === true,
      });
      const written = await writeJsonCopy({
        sourceSkeleton: base,
        outputJsonPath: args.outputJsonPath,
        json,
        overwrite: args.overwrite === true,
        dryRun: args.dryRun === true,
        backup: args.backup !== false,
      });
      return { ...written, ...(written.dryRun ? {} : { nextStep: NEXT_STEP_IMPORT }), ...summary };
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
      const written = await writeJsonCopy({
        sourceSkeleton: skeleton,
        outputJsonPath: args.outputJsonPath,
        json,
        overwrite: args.overwrite === true,
        dryRun: args.dryRun === true,
        backup: args.backup !== false,
      });
      return { ...written, ...(written.dryRun ? {} : { nextStep: NEXT_STEP_IMPORT }), ...summary };
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
        const out = path.join(args.outputDir, `${item.name}.${args.animationName}.json`);
        const result = await writeJsonCopy({
          sourceSkeleton: item.skeleton,
          outputJsonPath: out,
          json: item.json,
          overwrite: args.overwrite === true,
          dryRun: args.dryRun === true,
          backup: args.backup !== false,
        });
        written.push({ file: out, skeleton: item.name, ...item.summary, ...result });
      }
      const dryRun = args.dryRun === true;
      return { outputDir: args.outputDir, written, failures, ...(dryRun ? {} : { nextStep: NEXT_STEP_IMPORT }) };
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
      const written = await writeJsonCopy({
        sourceSkeleton: skeleton,
        outputJsonPath: args.outputJsonPath,
        json,
        overwrite: args.overwrite === true,
        dryRun: args.dryRun === true,
        backup: args.backup !== false,
      });
      return { ...written, ...(written.dryRun ? {} : { nextStep: NEXT_STEP_IMPORT }), ...summary };
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
      const written = await writeJsonCopy({
        sourceSkeleton: skeleton,
        outputJsonPath: args.outputJsonPath,
        json,
        overwrite: args.overwrite === true,
        dryRun: args.dryRun === true,
        backup: args.backup !== false,
      });
      return { ...written, ...(written.dryRun ? {} : { nextStep: NEXT_STEP_IMPORT }), ...summary };
    }

    case 'spine_audit_project': {
      const skeleton = await readJson(args.jsonPath);
      return { jsonPath: args.jsonPath, ...auditProject(skeleton) };
    }

    case 'spine_inspect_animation': {
      const skeleton = await readJson(args.jsonPath);
      return {
        jsonPath: args.jsonPath,
        ...inspectAnimation(skeleton, args.animationName, {
          includeKeyframes: args.includeKeyframes !== false,
          maxKeyframes: args.maxKeyframes ?? 1000,
        }),
      };
    }

    case 'spine_edit_animation': {
      const skeleton = await readJson(args.sourceJsonPath);
      const { json, summary } = editAnimation(skeleton, {
        mode: args.mode,
        animationName: args.animationName,
        newName: args.newName,
        offset: args.offset,
        scale: args.scale,
        start: args.start,
        end: args.end,
      });
      const written = await writeJsonCopy({
        sourceSkeleton: skeleton,
        outputJsonPath: args.outputJsonPath,
        json,
        overwrite: args.overwrite === true,
        dryRun: args.dryRun === true,
        backup: args.backup !== false,
      });
      return { ...written, ...(written.dryRun ? {} : { nextStep: NEXT_STEP_IMPORT }), ...summary };
    }

    case 'spine_edit_slots': {
      const skeleton = await readJson(args.sourceJsonPath);
      const mode = args.mode ?? 'list';
      const { json, summary, slots } = modifySlots(skeleton, {
        mode,
        slots: args.slots ?? [],
        rename: args.rename,
        order: args.order,
        dropAttachments: args.dropAttachments === true,
        dropAnimationTracks: args.dropAnimationTracks === true,
      });
      if (mode === 'list') return { sourceJsonPath: args.sourceJsonPath, slots };
      if (!args.outputJsonPath) throw new Error('非 list 模式必须提供 outputJsonPath');
      const written = await writeJsonCopy({
        sourceSkeleton: skeleton,
        outputJsonPath: args.outputJsonPath,
        json,
        overwrite: args.overwrite === true,
        dryRun: args.dryRun === true,
        backup: args.backup !== false,
      });
      return { ...written, ...(written.dryRun ? {} : { nextStep: NEXT_STEP_IMPORT }), ...summary };
    }

    case 'spine_edit_skins': {
      const skeleton = await readJson(args.sourceJsonPath);
      const mode = args.mode ?? 'list';
      const { json, summary, skins } = modifySkins(skeleton, {
        mode,
        skins: args.skins ?? [],
        rename: args.rename,
        attachments: args.attachments ?? [],
        dropDeformTracks: args.dropDeformTracks === true,
      });
      if (mode === 'list') return { sourceJsonPath: args.sourceJsonPath, skins };
      if (!args.outputJsonPath) throw new Error('非 list 模式必须提供 outputJsonPath');
      const written = await writeJsonCopy({
        sourceSkeleton: skeleton,
        outputJsonPath: args.outputJsonPath,
        json,
        overwrite: args.overwrite === true,
        dryRun: args.dryRun === true,
        backup: args.backup !== false,
      });
      return { ...written, ...(written.dryRun ? {} : { nextStep: NEXT_STEP_IMPORT }), ...summary };
    }

    case 'spine_inspect_constraints': {
      const skeleton = await readJson(args.jsonPath);
      return { jsonPath: args.jsonPath, ...inspectConstraints(skeleton) };
    }

    case 'spine_edit_constraints': {
      const skeleton = await readJson(args.sourceJsonPath);
      const mode = args.mode ?? 'list';
      const result = modifyConstraints(skeleton, {
        mode,
        type: args.type,
        name: args.name,
        newName: args.newName,
        constraint: args.constraint,
        dropAnimationTracks: args.dropAnimationTracks === true,
      });
      if (mode === 'list') return { sourceJsonPath: args.sourceJsonPath, ...result };
      if (!args.outputJsonPath) throw new Error('非 list 模式必须提供 outputJsonPath');
      const written = await writeJsonCopy({
        sourceSkeleton: skeleton,
        outputJsonPath: args.outputJsonPath,
        json: result.json,
        overwrite: args.overwrite === true,
        dryRun: args.dryRun === true,
        backup: args.backup !== false,
      });
      return {
        ...written,
        ...(written.dryRun ? {} : { nextStep: NEXT_STEP_IMPORT }),
        ...result.summary,
        constraintNames: (result.json[args.type] ?? []).map((entry) => entry?.name),
      };
    }

    case 'spine_inspect_atlas': {
      const atlasPath = assertSafePath(args.atlasPath, 'atlasPath', { mustExist: true });
      const imageDir = args.imageDir ? assertDirectory(args.imageDir, 'imageDir') : path.dirname(atlasPath);
      const text = await fs.readFile(atlasPath, 'utf8');
      return inspectAtlas(text, { source: atlasPath, imageDir });
    }

    case 'spine_audit_assets': {
      const skeleton = await readJson(args.jsonPath);
      const atlasPaths = args.atlasPaths ?? [];
      if (!Array.isArray(atlasPaths)) throw new Error('atlasPaths 必须是数组');
      const atlasReports = [];
      for (const [index, atlasPath] of atlasPaths.entries()) {
        const safePath = assertSafePath(atlasPath, `atlasPaths[${index}]`, { mustExist: true });
        const text = await fs.readFile(safePath, 'utf8');
        atlasReports.push(inspectAtlas(text, { source: safePath, imageDir: path.dirname(safePath) }));
      }
      const imageDir = args.imageDir ? assertDirectory(args.imageDir, 'imageDir') : null;
      return { jsonPath: args.jsonPath, ...auditAssets({ skeleton, atlasReports, imageDir }) };
    }

    case 'spine_export_workflow': {
      return runExportWorkflow({
        projectPath: args.projectPath,
        projects: args.projects ?? [],
        outputDir: args.outputDir,
        format: args.format,
        formats: args.formats ?? [],
        exportSettingsPath: args.exportSettingsPath,
        extraInputs: args.extraInputs ?? [],
        prettyPrint: args.prettyPrint,
        nonessential: args.nonessential,
        verify: args.verify === true,
        pack: args.pack,
        dryRun: args.dryRun === true,
      });
    }

    case 'spine_list_backups': {
      return listBackups({ limit: args.limit ?? 100 });
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}
