# spine-mcp-local（自研最小版）

面向 **Spine 3.8.75** 的本地 MCP server。零第三方依赖、纯 Node.js ≥20、stdio 传输。

与现成第三方包的区别：

| 项 | 本实现 | 第三方 spine-mcp-server |
|---|---|---|
| 依赖 | 0（只用 Node 内置模块） | 有依赖树，索引站标记过 high 告警 |
| 协议 | **dual-era**：legacy `initialize` + modern `server/discover` / `_meta` 版本 | 仅旧握手 |
| 帧规格 | 内置「N 帧 @ fps → Spine 秒 + 事件帧」换算与生成 | 无 |
| 写文件 | 只写副本，源文件永不改动；覆盖必须显式 `overwrite` | 支持原地导回 |
| 工具量 | 22 个 | 55 / 70 个 |

## 硬前提（做不到就别装）

1. 本机必须已安装 **Spine 3.8.75 Professional**，有正版授权，且能找到 `Spine.com`。
2. 环境变量 `SPINE_EXE` 指向该可执行文件（由 MCP 配置的 `env` 传入）。
3. Node.js ≥ 20（开发机 v22.22.2 已验证）。

**MCP 不包含 Spine，也不会安装 Spine。** 没有 Spine 时，`spine_doctor`、`spine_inspect_json`、`spine_frames_to_seconds`、`spine_build_combat_animation`、`spine_validate_timeline`、`spine_make_export_settings` 仍可正常工作，只有 CLI 类工具会失败。

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

## 22 个工具

| 工具 | 作用 | 需要 Spine |
|---|---|---|
| `spine_doctor` | 检查 Node / SPINE_EXE / 协议版本；`probe=true` 时跑 `--help` | 可选 |
| `spine_inspect_json` | 只读解析导出的 skeleton JSON，列出骨骼/插槽/皮肤/动画/事件 | 否 |
| `spine_frames_to_seconds` | 帧规格 → Spine 秒表，标出命中帧 | 否 |
| `spine_build_combat_animation` | 在 JSON **副本**上写骨骼关键帧、插槽换图、事件帧 | 否 |
| `spine_validate_timeline` | 静态校验时间轴递增、骨骼存在、事件定义齐全 | 否 |
| `spine_export` | 官方 CLI 导出（`-i / -o / -e`，可选 `-m`） | 是 |
| `spine_import_json` | 官方 CLI 导入 JSON / binary / 另一个工程的 skeleton（`-r`，可选 `-s`） | 是 |
| `spine_clean` | 官方 CLI 清理（`-m`） | 是 |
| `spine_reload_gui` | 方案 C：请求 Spine GUI 重新打开工程（官方 Editor 模式），支持 `dryRun` | 可选 |
| `spine_project_info` | 只读工程信息（`-i` Info），返回原始输出 + 结构化摘要 | 是 |
| `spine_version` | 启动器版本信息（`--version`），只读 | 是 |
| `spine_make_export_settings` | 生成导出设置 JSON（`json` / `binary` 均已验证），供 `spine_export` 的 `-e` 使用 | 否 |
| `spine_verify_export` | 只读比对源工程与导出目录产物的骨骼 / 插槽 / 动画列表 | 是 |
| `spine_pack_atlas` | 图集打包（`-i/-o/-p`，可选 `-j`/`-n`），支持图集名或 pack.json | 是 |
| `spine_unpack_atlas` | 图集解包（`-i/-o/-c`），把 atlas 页还原成散图 | 是 |
| `spine_restore_backup` | 把写前备份恢复回 `.spine` 工程，需 `overwrite:true`，恢复前再备份当前目标 | 否 |
| `spine_diff_animations` | 只读对比两份 skeleton JSON 的动画与事件定义差异 | 否 |
| `spine_merge_animations` | 把 donor 的动画合并进 base 的副本，自动补齐事件定义 | 否 |
| `spine_manage_events` | 事件定义独立管理：`list` / `add` / `remove` / `rename` | 否 |
| `spine_build_batch_animations` | 多 skeleton 批量生成同名动画副本，单个失败不影响其它 | 否 |
| `spine_modify_bones` | 在 JSON 副本上改骨骼结构 / setup pose：`list`/`add`/`remove`/`rename`/`reparent`/`set` | 否 |
| `spine_edit_weights` | 网格权重数值层：`inspect` 校验 / `normalize` 归一化 / `scale` 按骨骼缩放 | 否 |

## 写操作与人工重载（P0）

- 按项目约定，**不做自动重载**。所有会写 `.spine` 的工具（`spine_clean`、`spine_import_json`，以及 `spine_export` 的 `clean:true`）在成功后返回 `requiresManualReload: true` 与 `reloadHint`，提示在编辑器里手动 `Ctrl+O`；失败时不附加，避免误导。
- `spine_build_combat_animation` 写的是 JSON 副本，返回 `nextStep`，提示手动 `File → Import Data` 导入，不自动重载工程。
- `spine_make_export_settings` 只生成设置文件，不改 `.spine`；已验证并开放 `export-json` 与 `export-binary`，图片 / 视频格式未验证故不开放，不猜格式。`settings.output` 会被 `spine_export` 的 `outputDir` 覆盖。
- `spine_project_info` 封装官方 `-i` Info 模式，只读；`parsed` 含 `spineVersion` / `dopesheetFps` / `skeletons`（骨骼、插槽、动画列表），解析不出来时为 `null`，原始 `stdout` 始终保留。

## P1：写前备份、多格式导出与产物校验

- **实测结论**：`spine_clean`（`-i -m`）会**原地改写** `.spine`（副本 10750 → 7994 字节、哈希变化），`spine_import_json`（`-r`）会生成新的 `.spine`，两者 exitCode 均为 0；官方 `-i` Info 也能直接读导出的 skeleton 数据文件（`Project info: null`，但骨骼 / 插槽 / 动画列表完整）。
- **写前备份**：`spine_clean` 默认 `backup: true`；`spine_import_json` 在 `overwrite: true`、`spine_export` 在 `clean: true` 时默认备份。备份落到系统临时目录 `spine-mcp-backups/`，不污染工程目录与 git 工作区，返回 `backupPath` / `backupHint`；显式 `backup: false` 可关闭。
- **多格式导出**：`spine_make_export_settings` 的 `format` 支持 `json` / `binary`，两种设置都已在副本上真实导出验证；图片 / 视频格式未验证，不开放。
- **`spine_verify_export`**：对源工程与导出目录里每个 `.json` 产物分别跑官方 `-i` Info，按 skeleton 名比对 `bones` / `slots` / `animations` 列表，返回 `ok` / `matched` / `missing` / `mismatches`。只读，但会多次启动 CLI，较慢。
- **批量导出**：`spine_export` 的 `extraInputs` 可追加多组 `-i/-e`；实测一次调用里混合 JSON 与 Binary 导出成功（exit 0）。
- 写操作成功后仍统一返回 `requiresManualReload` + `reloadHint`（手动 Ctrl+O），不自动重载。
- 尚未做：图片 / 视频导出设置、产物二进制内容级比对（当前只比结构）。

## P2：图集能力与备份回滚

- **实测（3.8.75）**：`-i <images> -o <out> -p <name>` 打包成功（产出 `.atlas` + `.png`）；带 `-n <name> -p <pack.json>` 的设置文件形式成功；`-i <atlas images> -o <out> -c <file.atlas>` 解包成功（还原出 7 张 PNG）；`-i <另一个 .spine> -o <新 .spine> -r` 导入工程 skeleton 成功。
- `spine_pack_atlas` 封装两种 pack 形式，可选 `projectPaths`（多个 `-j`，用于 mesh 判断哪些图片被用到）；`spine_unpack_atlas` 封装 `-c`。两者只写 `outputDir`，不碰源图片目录。
- `-r` 的工程输入**不需要新工具**：现有 `spine_import_json` 的 `inputPath` 直接传 `.spine` 即可，工具描述已注明。
- `spine_restore_backup` 补齐 P1 备份的闭环：恢复会覆盖目标，必须显式 `overwrite:true`；恢复前自动把当前目标再备份一次（返回 `preRestoreBackup`），成功后返回 `requiresManualReload` + `reloadHint`（手动 Ctrl+O）。
## P3：动画工作流（纯 JSON 层）

- 全部为**离线纯逻辑**，不调用 Spine CLI、不碰 GUI、不写源文件；实现集中在 `src/animation-ops.mjs`。
- `spine_diff_animations`：对比两份 skeleton JSON，返回动画的 `added` / `removed` / `changed` / `unchanged`（附关键帧数与事件数）与顶层 `events` 定义差异；序列化时按键排序，避免属性顺序造成误报。
- `spine_merge_animations`：把 donor 动画合并到 base 副本，默认跳过同名（`overwrite:true` 才覆盖），并自动把 donor 的事件定义补到副本里；可用 `animationNames` 只挑指定动画。
- `spine_manage_events`：`list` 只读（列出定义及被哪些动画引用）；`add` / `remove` / `rename` 写副本，rename 会同步改写所有动画里的事件名，remove 会警告仍在引用该事件的动画。
- `spine_build_batch_animations`：对多个导出的 skeleton JSON 各生成一条同名动画副本，支持 `boneControlsBySkeleton` 分别指定骨骼、`skipMissingBones` 自动过滤各 skeleton 不存在的骨骼；单个失败只记入 `failures`，不影响其它。
- 这四个工具写的都是 JSON 副本，统一返回 `nextStep`，提示手动 `File → Import Data`；**不自动重载工程**。
- **仍有意排除**：图片 / 视频导出设置（格式未验证，不猜）、产物二进制内容级比对、任何 GUI 自动化。

## P4：骨骼结构与 setup pose 修改（纯 JSON 层）

- 新增 `spine_modify_bones`，在导出的 skeleton JSON **副本**上操作 `bones[]`；不写 `.spine`、不碰 GUI、不改源文件，返回 `nextStep` 提示手动 `Import Data`。
- `list`（只读）按数组下标列出骨骼名、父级与 setup pose 字段；`add` 追加新骨骼（校验重名 / 父级存在 / 字段类型，**追加到末尾**，不打乱已有下标）；`set` 改 `x/y/rotation/scaleX/scaleY/shearX/shearY/length/color/transform` 等白名单字段；`rename` 同步改写 `parent`、`slots[].bone`、`animations[*].bones` 键、`ik[].bones/target`；`reparent` 改父级并检测循环；`remove` 默认拒绝任何仍被引用的骨骼。
- **为什么删除受限**：3.8.75 的 mesh 权重编码在 `vertices` 里、用 `bones` 数组下标引用骨骼（官方示例 `raptor-pro.json` 实测为 `[boneCount, boneIndex, x, y, weight, ...]`）。删中间骨骼会让所有权重错位，所以工程含加权 mesh 时**一律拒绝删除**，请改用 `rename` / `set` 或在编辑器里处理蒙皮。
- `remove` 的 `reparentChildren` / `dropAnimationTracks` 可自动重接子骨骼、清理动画时间轴；插槽与 IK 引用仍一律拒绝删除。
## P4b：网格权重数值（纯 JSON 层）

- **格式实测**：3.8.75 带权重的 mesh 把数据编码在 `vertices`：`[boneCount, boneIndex, x, y, weight, ...]`；未加权 mesh 是纯 `[x, y, ...]`（`vertices.length === uvs.length`）。官方示例 305 个 mesh 均无 `bones` 局部映射字段，`boneIndex` 直接是 `skeleton.bones` 下标（实现仍兼容 `att.bones` 旧写法）。
- `spine_edit_weights` 三种模式：`inspect` 只读（加权 mesh 数、顶点数、权重和偏离 1 的顶点、无效骨骼下标、每根骨骼的权重汇总）；`normalize` 把每个顶点权重归一到和 = 1；`scale` 按骨骼名 / 下标把该骨骼的权重乘以 `factor`，再逐顶点归一化。
- 只改 `weight` 数值，**不动顶点坐标、骨骼归属、`att.bones` 映射、骨骼数量**；写 JSON 副本并返回 `nextStep`（手动 Import Data）。
- **仍做不到**：在编辑器里刷权重、创建 / 编辑 mesh 封套、实时拖骨骼与预览形变（GUI 交互，按约定不做自动化）。数值层能改权重，但改完必须 `spine_import_json` 导回并在编辑器里人工复核形变。

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

- 不替代 Spine 编辑器、不绕过商业授权；不做鼠标键盘模拟、窗口自动化、时间轴拖动、mesh 封套编辑、编辑器里刷权重、IK 约束创建、预览渲染。骨骼**结构与 setup pose 数值**（`spine_modify_bones`）、**网格权重数值**（`spine_edit_weights` 的 inspect / normalize / scale）都可在 JSON 副本上修改（P4 / P4b），但编辑器里的交互式骨骼 / 权重操作仍不支持。GUI 联动只通过 `spine_reload_gui` 调用官方 Editor 模式请求重新打开工程。
- `.spine` 的一切改动只经官方 CLI；动画生成只写 skeleton JSON 副本，**不直接改 .spine 二进制**。
- CLI 参数构造依据 1425sd/spine-MCP 项目记录的 3.8.75 用法；本机已端到端验证 `--help`、`-i` 只读 Info、`spine_export`（`json` / `binary` 副本真实导出，exitCode 0）、`spine_import_json`、`spine_clean`，以及「导出 → `spine_inspect_json` → `spine_build_combat_animation` → `spine_validate_timeline`」全链路；多 `-i/-e` 批量导出（混合 JSON / Binary）、图集 pack / unpack、以及 `-r` 导入另一个工程的 skeleton 均已实测；P3 的 diff / 合并 / 事件管理 / 批量生成、P4 的骨骼修改与 P4b 的权重数值均由离线单测覆盖；**未验证**：图片 / 视频导出设置（格式未验证，不开放）、产物二进制内容级比对。协议层与纯逻辑层已跑通自动化测试。
- 无图集拆分 / 自动绑骨 / 预览渲染 / Cocos 扩展，这些是后续可扩展项，不是本版能力。
