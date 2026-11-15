import fs from 'node:fs/promises';
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
import { requestGuiReload } from './gui-link.mjs';

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
      },
      required: ['inputPath', 'outputDir', 'exportSettingsPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'spine_import_json',
    description: '调用官方 Spine CLI 把 JSON 导回 .spine 工程（-r）。',
    inputSchema: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: '输入 JSON / skel 绝对路径' },
        outputPath: { type: 'string', description: '输出 .spine 绝对路径' },
        scale: { type: 'number', exclusiveMinimum: 0 },
        skeletonName: { type: 'string' },
        overwrite: { type: 'boolean', description: '输出已存在时是否覆盖，默认 false' },
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
      properties: { inputPath: { type: 'string', description: '.spine 工程绝对路径' } },
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
      return { writtenTo: outputPath, sourceUnchanged: true, ...summary };
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
      });
      return runSpine(cliArgs);
    }

    case 'spine_import_json': {
      const cliArgs = importArgs({
        inputPath: args.inputPath,
        outputPath: args.outputPath,
        scale: args.scale,
        skeletonName: args.skeletonName,
      });
      assertWritableOutput(args.outputPath, 'outputPath', args.overwrite === true);
      return runSpine(cliArgs);
    }

    case 'spine_clean': {
      return runSpine(cleanArgs({ inputPath: args.inputPath }));
    }

    case 'spine_reload_gui': {
      return requestGuiReload({
        projectPath: args.projectPath,
        dryRun: args.dryRun === true,
        allowWhenRunning: args.allowWhenRunning === true,
      });
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}
