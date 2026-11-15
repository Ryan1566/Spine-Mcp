# spine-mcp-local（自研最小版）

面向 **Spine 3.8.75** 的本地 MCP server。零第三方依赖、纯 Node.js ≥20、stdio 传输。

与现成第三方包的区别：

| 项 | 本实现 | 第三方 spine-mcp-server |
|---|---|---|
| 依赖 | 0（只用 Node 内置模块） | 有依赖树，索引站标记过 high 告警 |
| 协议 | **dual-era**：legacy `initialize` + modern `server/discover` / `_meta` 版本 | 仅旧握手 |
| 帧规格 | 内置「N 帧 @ fps → Spine 秒 + 事件帧」换算与生成 | 无 |
| 写文件 | 只写副本，源文件永不改动；覆盖必须显式 `overwrite` | 支持原地导回 |
| 工具量 | 8 个 | 55 / 70 个 |

## 硬前提（做不到就别装）

1. 本机必须已安装 **Spine 3.8.75 Professional**，有正版授权，且能找到 `Spine.com`。
2. 环境变量 `SPINE_EXE` 指向该可执行文件（由 MCP 配置的 `env` 传入）。
3. Node.js ≥ 20（开发机 v22.22.2 已验证）。

**MCP 不包含 Spine，也不会安装 Spine。** 没有 Spine 时，`spine_doctor`、`spine_inspect_json`、`spine_frames_to_seconds`、`spine_build_combat_animation`、`spine_validate_timeline` 仍可正常工作，只有 CLI 类工具会失败。

## 跑起来

```bash
cd D:/spine-mcp
node --test tests/*.test.mjs     # 不需要 npm install
node src/index.mjs               # 作为 stdio MCP server 启动
```

把 `mcp-config.example.json` 里的 `SPINE_EXE` 改成真实路径后，合并进客户端的 MCP 配置（如 WorkBuddy 的 `~/.workbuddy/mcp.json` 的 `mcpServers`），再在连接器管理里信任该服务。不要覆盖已有条目。

## 8 个工具

| 工具 | 作用 | 需要 Spine |
|---|---|---|
| `spine_doctor` | 检查 Node / SPINE_EXE / 协议版本；`probe=true` 时跑 `--help` | 可选 |
| `spine_inspect_json` | 只读解析导出的 skeleton JSON，列出骨骼/插槽/皮肤/动画/事件 | 否 |
| `spine_frames_to_seconds` | 帧规格 → Spine 秒表，标出命中帧 | 否 |
| `spine_build_combat_animation` | 在 JSON **副本**上写骨骼关键帧、插槽换图、事件帧 | 否 |
| `spine_validate_timeline` | 静态校验时间轴递增、骨骼存在、事件定义齐全 | 否 |
| `spine_export` | 官方 CLI 导出（`-i / -o / -e`，可选 `-m`） | 是 |
| `spine_import_json` | 官方 CLI 导回 `.spine`（`-r`，可选 `-s`） | 是 |
| `spine_clean` | 官方 CLI 清理（`-m`） | 是 |

## 典型工作流：8 帧普攻、F3 命中

Spine 时间轴用**秒**不是帧，第 N 帧（1-based）的时间是 `(N-1)/fps`。12 fps 下 8 帧 = 0.666667s，命中帧 F3 = **0.166667s**。

1. `spine_export` 把 `.spine` 导成 JSON（必须给 `exportSettingsPath`）。
2. `spine_inspect_json` 确认骨骼名，例如 `weapon`、`head`。
3. `spine_frames_to_seconds`：`{ "fps": 12, "frames": 8, "eventFrames": [{ "frame": 3, "name": "hit" }] }`。
4. `spine_build_combat_animation`：

```json
{
  "sourceJsonPath": "D:/proj/hero.json",
  "outputJsonPath": "D:/proj/hero.attack.json",
  "animationName": "attack_01",
  "fps": 12,
  "frames": 8,
  "boneControls": [
    {
      "bone": "weapon",
      "rotate": [
        { "frame": 1, "angle": -10 },
        { "frame": 3, "angle": 35 },
        { "frame": 5, "angle": 12 },
        { "frame": 8, "angle": 0 }
      ]
    }
  ],
  "eventFrames": [
    { "frame": 3, "name": "hit", "int": 1 },
    { "frame": 6, "name": "recover" }
  ]
}
```

事件名若不在源 JSON 的顶层 `events` 里会自动补齐定义；伤害数字、震屏、音效都挂 `time=0.166667` 这一帧。

5. `spine_validate_timeline` 校验。
6. `spine_import_json` 导回 `.spine`，人工在编辑器里复核。

## Spine 3.8.75 的坑

- **导出必须带设置文件**：`Spine -i <in> -o <out> -e <export-settings.json>`。`-e` 不接受 `json`、`json+pack` 这类模式字符串；本实现在设置文件不存在时**直接报错，不发起 CLI 调用**。
- 路径正确仍失败时，先手动跑 `& "$env:SPINE_EXE" --help`，对照 MCP 返回的 `command` / `args`；不同 Spine 版本的参数与设置 JSON 格式不通用。
- 3.8.75 与 4.x 的 skeleton JSON 不通用，别混用。
- stdio 的 stdout 只输出 MCP 消息，日志全走 stderr；配置后若显示「暂无工具」需重启客户端。

## 协议兼容

- **legacy**（2025-11-25 及更早）：响应 `initialize`，支持 2025-06-18 / 2025-03-26 / 2024-11-05。
- **modern**（2026-07-28）：实现强制的 `server/discover`，每请求读 `_meta` 的 `io.modelcontextprotocol/protocolVersion`；不支持的版本返回 `-32022` 并列出 `supported`。
- 空能力查询 `resources/list`、`prompts/list` 返回空集，避免部分客户端报错。

## 能力边界（如实列出）

- 不替代 Spine 编辑器、不绕过商业授权；不做 UI 自动化、鼠标键盘模拟、时间轴拖动、网格绑定、骨骼权重、IK 创建。
- `.spine` 的一切改动只经官方 CLI；动画生成只写 skeleton JSON 副本，**不直接改 .spine 二进制**。
- CLI 参数构造依据 1425sd/spine-MCP 项目记录的 3.8.75 用法；本机已验证 `Spine.com --help` 与 `-i <project.spine>` 只读 Info 模式（均 exitCode 0），**导出 / 导入 / 清理尚未端到端验证**；协议层与纯逻辑层已跑通自动化测试。
- 无图集拆分 / 自动绑骨 / 预览渲染 / Cocos 扩展，这些是后续可扩展项，不是本版能力。
