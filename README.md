# spine-mcp-local（自研最小版）

面向 **Spine 3.8.75** 的本地 MCP server。零第三方依赖、纯 Node.js ≥20、stdio 传输。

与现成第三方包的区别：

| 项 | 本实现 | 第三方 spine-mcp-server |
|---|---|---|
| 依赖 | 0（只用 Node 内置模块） | 有依赖树，索引站标记过 high 告警 |
| 协议 | **dual-era**：legacy `initialize` + modern `server/discover` / `_meta` 版本 | 仅旧握手 |
| 帧规格 | 内置「N 帧 @ fps → Spine 秒 + 事件帧」换算与生成 | 无 |
| 写文件 | 只写副本，源文件永不改动；覆盖必须显式 `overwrite` | 支持原地导回 |
| 工具量 | 9 个 | 55 / 70 个 |

## 硬前提（做不到就别装）

1. 本机必须已安装 **Spine 3.8.75 Professional**，有正版授权，且能找到 `Spine.com`。
2. 环境变量 `SPINE_EXE` 指向该可执行文件（由 MCP 配置的 `env` 传入）。
3. Node.js ≥ 20（开发机 v22.22.2 已验证）。

**MCP 不包含 Spine，也不会安装 Spine。** 没有 Spine 时，`spine_doctor`、`spine_inspect_json`、`spine_frames_to_seconds`、`spine_build_combat_animation`、`spine_validate_timeline` 仍可正常工作，只有 CLI 类工具会失败。

## 跑起来

```bash
cd D:/spine-mcp                 # 本机工作副本；新机器先 git clone https://github.com/Ryan1566/Spine-Mcp.git
node --test tests/*.test.mjs     # 不需要 npm install
node src/index.mjs               # 作为 stdio MCP server 启动
```

仓库：`https://github.com/Ryan1566/Spine-Mcp.git`（分支 `main`）；本机工作副本在 `D:/spine-mcp`。`mcp-config.example.json` 已填入本机真实的 `SPINE_EXE`，本机配置写在 `~/.workbuddy/mcp.json` 的 `mcpServers["spine-mcp-local"]`（**不入库**）。首次使用需在连接器管理页信任该自定义 MCP 并重启客户端，日志出现 `state=ready` 即接入成功；工具清单在会话启动时注入，看不到工具就新开一个任务。换机器或 clone 到别的目录时，记得同步修改配置里的 `args` 与 `SPINE_EXE`；合并配置时不要覆盖已有条目。

DSH（DeepSeek Harness）：把仓库里的 `dsh-spine-mcp.patch.yml` 追加到 `~/.dsh/profiles/<profile>/cordis.patch.yml` 用户补丁层，重启 DSH 后生效，工具以 `mcp__spine__<工具名>` 暴露（借用 DSH 自带的 `@deepseek-ai/dsh-mcp-client`，不用装依赖）。

### 和 DSH 对接时必须满足的两条线协议细节

DSH 的 `dsh-mcp-client` 直接说 2026-07-28 现代时代（先 `server/discover`，之后每个请求都带 `_meta` 信封），并且对结果做严格 schema 校验。踩过两个坑：

1. **`_meta` 里的版本号不能一律按“现代声明”拒**。旧时代客户端会把协商到的 `2025-06-18` / `2025-11-25` 回显进 `_meta`；早期实现直接回 `-32022`，结果是 `initial connection or tool synchronization failed`。现在的判定：现代版本放行、旧时代版本放行、未知版本只在客户端做过 `server/discover` 之后才回 `-32022`。
2. **可缓存结果必须带 `ttlMs` + `cacheScope`**。2026-07-28 把 `tools/list`、`prompts/list`、`resources/list`、`resources/templates/list`、`resources/read`、`server/discover` 定义成 `CacheableResult`，缺字段会报 `Invalid result for tools/list: ttlMs ... cacheScope ...`。本仓库统一填规范默认值 `ttlMs: 0`、`cacheScope: 'private'`（`src/server.mjs` 的 `CACHE_FIELDS`）。

排查时可用 `MCP_DEBUG_LOG=<文件路径>` 环境变量让 server 把收发原始报文追加进文件（默认关闭，不写任何文件）。

### 调用前先自检：跑的是不是最新代码

MCP server 是宿主在启动/重载那一刻 spawn 的独立进程，代码在 spawn 时固定。之后 `src/*.mjs` 再怎么改，正在跑的实例都不会热更新，**也不会报错**——只会「工具行为对不上」（典型症状：磁盘上有 9 个工具，会话里只见 8 个）。

每个实例启动时把 `src/*.mjs` 的指纹（含每个文件的 hash）写进 `.runtime/server-<pid>.json`（`.runtime/` 已 gitignore），所以比对只要一条命令：

```bash
node scripts/check-update.mjs      # 等价 npm run check
```

- 退出码 `0`：运行实例与磁盘一致。
- 退出码 `1`：进程落后于磁盘，会列出具体哪个文件变了、工具清单差在哪；先重载再用工具（DSH 用 `plugin_manager set_plugin(include:mcp-spine, enabled:false)` → `enabled:true`，WorkBuddy 侧重连该 MCP）。
- 退出码 `2`：没找到活实例，先确认宿主已连上（`spine_doctor` 能返回即说明连上了）。

`spine_doctor` 的返回里也带同一份指纹（`build.pid` / `build.startedAt` / `build.sourceHash` / `build.toolCount`），不跑脚本也能判断手里的实例是不是旧的。

## 9 个工具

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
| `spine_reload_gui` | 方案 C：请求 Spine GUI 重新打开工程（官方 Editor 模式），支持 `dryRun` | 可选 |

## 与 GUI 联动（方案 C）

CLI 与 Spine 编辑器是两个独立进程：GUI 把工程读进内存，不监听磁盘变化，所以 CLI 写完 `.spine` 后窗口里还是旧内容。官方 CLI 没有 reload / watch 参数，`prefs.json` 没有自动重载开关，`hotkeys.txt` 里只有 `Ctrl+O` 打开工程、`Ctrl+S` 保存。

`spine_reload_gui` 用官方 Editor 模式补上这一环：

```json
{
  "projectPath": "C:/path/to/project.spine",
  "dryRun": true
}
```

- `dryRun: true`（建议先用）返回 `strategy` / `guiExe` / `args` / `guiRunning` / `wouldBlock`，不启动任何进程。
- 实际执行时以 `detached` 方式 spawn `Spine.exe <工程路径>`，不等待 GUI 退出。`guiExe` 优先取环境变量 `SPINE_GUI_EXE`，否则把 `SPINE_EXE` 同目录的 `.com` 换成 `.exe`；**不提供「启动任意程序」的参数**。
- **本机实测（3.8.75）**：GUI 已运行时再启动 `Spine.exe` **不会转发工程路径**。launcher 会因单实例锁 `C:\Users\<user>\Spine\.lock` 报 `WARNING: Unable to obtain file lock` / `FileNotFoundException ... 拒绝访问` 后退出，原窗口标题与 `recent.json` 都不变——「CLI 改盘 → GUI 自动刷新」这条官方路径并不存在。
- 因此工具默认做锁检测：对 `.lock` 以 `r+` 打开，被占用（`EPERM`）即判定已有 GUI；这是只读探测，不改锁文件。检测到已有实例时返回 `blocked: true` / `launched: false` 与 `hint`，**不产生注定失败的进程**；`allowWhenRunning: true` 可强制尝试。
- 可行的联动路径：① 在 GUI 里手动 `Ctrl+O` 重新打开（或用 `Import Data` 导入生成的 JSON）；② 先在编辑器 `Ctrl+S` 并关闭 GUI，再调用本工具以 Editor 模式重新打开工程（此时无锁，能成功）；③ 若一定要在 GUI 开着时自动重载，需要 UI 自动化层模拟 `Ctrl+O`，本版不做。
- **不模拟鼠标键盘、不读写工程文件、不自动保存**。GUI 里若有未保存改动，先手动 `Ctrl+S`，否则重新打开后会被磁盘版本覆盖。
- 文件监听式自动重载（检测到 `.spine` 变化就自动触发）尚未实现，避免后台抢焦点，可作为后续扩展。

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
- **设置文件的最小可用格式**见 `fixtures/export-settings.example.json`：顶层是单个对象，`class` 为 `export-json`，`cleanUp` 保持 `false`；其中 `output` 会被命令行的 `-o` 覆盖，可以留占位路径。
- **导出目录不要放在 skeleton 图片目录里**：CLI 会警告 `The output folder is inside a skeleton image folder` 并可能删除同名图集图片，单独建空目录最安全。副本脱离原工程时还会报 `Images path not found: ../images/...`，但 JSON 导出不依赖图片，仍会成功。
- 导出会启动完整编辑器进程（日志带 GPU 信息），不是纯 launcher 调用；`--help` 与 `-i` Info 才是轻量只读操作。
- 路径正确仍失败时，先手动跑 `& "$env:SPINE_EXE" --help`，对照 MCP 返回的 `command` / `args`；不同 Spine 版本的参数与设置 JSON 格式不通用。
- launcher 每次会联网拉 welcome data，常报 `WARNING: Welcome data download failed, server error: 410`；这是 3.8.75 服务端接口下线的正常噪声，CLI 仍会正常完成（exitCode 0），不影响导出结果。
- 3.8.75 与 4.x 的 skeleton JSON 不通用，别混用。
- stdio 的 stdout 只输出 MCP 消息，日志全走 stderr；配置后若显示「暂无工具」需重启客户端。

## 协议兼容

- **legacy**（2025-11-25 及更早）：响应 `initialize`，支持 2025-06-18 / 2025-03-26 / 2024-11-05。
- **modern**（2026-07-28）：实现强制的 `server/discover`，每请求读 `_meta` 的 `io.modelcontextprotocol/protocolVersion`；不支持的版本返回 `-32022` 并列出 `supported`。
- 空能力查询 `resources/list`、`prompts/list` 返回空集，避免部分客户端报错。

## 能力边界（如实列出）

- 不替代 Spine 编辑器、不绕过商业授权；不做鼠标键盘模拟、窗口自动化、时间轴拖动、网格绑定、骨骼权重、IK 创建。GUI 联动只通过 `spine_reload_gui` 调用官方 Editor 模式请求重新打开工程。
- `.spine` 的一切改动只经官方 CLI；动画生成只写 skeleton JSON 副本，**不直接改 .spine 二进制**。
- CLI 参数构造依据 1425sd/spine-MCP 项目记录的 3.8.75 用法；本机已端到端验证 `--help`、`-i` 只读 Info、`spine_export`（副本真实导出，exitCode 0，产出 `citizen_001.json` / `skeleton.json`），以及「导出 → `spine_inspect_json` → `spine_build_combat_animation` → `spine_validate_timeline`」全链路；**`spine_import_json` / `spine_clean` 仍未验证**（两者会写 `.spine` 工程）。协议层与纯逻辑层已跑通自动化测试。
- 无图集拆分 / 自动绑骨 / 预览渲染 / Cocos 扩展，这些是后续可扩展项，不是本版能力。
