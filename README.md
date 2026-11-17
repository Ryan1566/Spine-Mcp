# spine-mcp-local（自研最小版）

面向 **Spine 3.8.75** 的本地 MCP server。零第三方依赖、纯 Node.js ≥20、stdio 传输。

与现成第三方包的区别：

| 项 | 本实现 | 第三方 spine-mcp-server |
|---|---|---|
| 依赖 | 0（只用 Node 内置模块） | 有依赖树，索引站标记过 high 告警 |
| 协议 | **dual-era**：legacy `initialize` + modern `server/discover` / `_meta` 版本 | 仅旧握手 |
| 帧规格 | 内置「N 帧 @ fps → Spine 秒 + 事件帧」换算与生成 | 无 |
| 写文件 | 只写副本，源文件永不改动；覆盖必须显式 `overwrite` | 支持原地导回 |
| 工具量 | 32 个 | 55 / 70 个 |

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

## 41 个工具

| 工具 | 作用 | 需要 Spine |
|---|---|---|
| `spine_doctor` | 检查 Node / SPINE_EXE / 协议版本；`probe=true` 时跑 `--help` | 可选 |
| `spine_inspect_json` | 只读解析导出的 skeleton JSON，列出骨骼/插槽/皮肤/动画/事件 | 否 |
| `spine_inspect_skel` | 只读解析二进制 `.skel`：逐字段读到文件末尾，回传结构计数、动画时长与引用完整性检查 | 否 |
| `spine_inspect_mesh` | 只读解析面片结构：每个 mesh 的顶点 / 三角面 / UV / 逐顶点骨骼权重，可按骨骼反查影响面片 | 否 |
| `spine_frames_to_seconds` | 帧规格 → Spine 秒表，标出命中帧 | 否 |
| `spine_build_combat_animation` | 在 JSON **副本**上写骨骼关键帧、插槽换图、事件帧 | 否 |
| `spine_validate_timeline` | 静态校验时间轴递增、骨骼存在、事件定义齐全 | 否 |
| `spine_export` | 官方 CLI 导出（`-i / -o / -e`，可选 `-m`）；数据导出 `-o` 是目录，渲染导出 `-o` 是文件基名并回传产物清单 | 是 |
| `spine_import_json` | 官方 CLI 导入 JSON / binary / 另一个工程的 skeleton（`-r`，可选 `-s`） | 是 |
| `spine_clean` | 官方 CLI 清理（`-m`） | 是 |
| `spine_gui_status` | 查 GUI 当前打开的工程（读进程窗口标题，不看 mtime），写操作前的必查项 | 可选 |
| `spine_reload_gui` | 方案 C：请求 Spine GUI 重新打开工程（官方 Editor 模式），支持 `dryRun` | 可选 |
| `spine_project_info` | 只读工程信息（`-i` Info），返回原始输出 + 结构化摘要 | 是 |
| `spine_version` | 启动器版本信息（`--version`），只读 | 是 |
| `spine_make_export_settings` | 生成导出设置 JSON：数据导出 `json` / `binary`，渲染导出 `png` / `mov` / `avi` / `gif`，均已实测 | 否 |
| `spine_verify_export` | 只读比对源工程与导出目录产物（`.json` 走 CLI、`.skel` 走本地解析）的骨骼 / 插槽 / 动画 / IK 列表 | 是 |
| `spine_render_preview` | 一行式渲染预览：给工程与输出目录就出图，自动生成并清理临时导出设置 | 是 |
| `spine_get_wireframe` | 求解 setup pose 或「动画 + 秒数」时刻的骨架：回传骨骼世界变换、面片顶点世界坐标、region 可见四边形，可出 SVG / 自包含 HTML | 否 |
| `spine_align_check` | 把线框等比贴合到渲染图前景，回传骨骼命中率、面片重心命中数、三角面覆盖 IoU 与随机基准 | 否 |
| `spine_pack_atlas` | 图集打包（`-i/-o/-p`，可选 `-j`/`-n`），支持图集名或 pack.json | 是 |
| `spine_unpack_atlas` | 图集解包（`-i/-o/-c`），把 atlas 页还原成散图 | 是 |
| `spine_restore_backup` | 把写前备份恢复回 `.spine` 工程，需 `overwrite:true`，恢复前再备份当前目标 | 否 |
| `spine_diff_animations` | 只读对比两份 skeleton JSON 的动画与事件定义差异 | 否 |
| `spine_merge_animations` | 把 donor 的动画合并进 base 的副本，自动补齐事件定义 | 否 |
| `spine_manage_events` | 事件定义独立管理：`list` / `add` / `remove` / `rename` | 否 |
| `spine_build_batch_animations` | 多 skeleton 批量生成同名动画副本，单个失败不影响其它 | 否 |
| `spine_modify_bones` | 在 JSON 副本上改骨骼结构 / setup pose：`list`/`add`/`remove`/`rename`/`reparent`/`set` | 否 |
| `spine_edit_weights` | 网格权重数值层：`inspect` 校验 / `normalize` 归一化 / `scale` 按骨骼缩放 | 否 |
| `spine_audit_project` | 只读体检骨骼、插槽、附件、mesh、权重与全部动画引用 | 否 |
| `spine_inspect_animation` | 查看单条动画的全部时间轴类型、关键帧、曲线与时长 | 否 |
| `spine_edit_animation` | 动画副本：复制 / 改名 / 删除 / 时间平移 / 时长缩放 / 区间裁剪 | 否 |
| `spine_edit_slots` | 插槽副本：新增 / 删除（引用保护）/ 改名 / setup 字段 / 排序 | 否 |
| `spine_edit_skins` | 皮肤副本：新增 / 删除 / 改名 / 按插槽分配附件 | 否 |
| `spine_inspect_constraints` | 只读检查 IK / transform / path 约束与动画使用 | 否 |
| `spine_edit_constraints` | 约束副本：新增 / 删除（引用保护）/ 改名（同步动画轨道）/ 改参数 | 否 |
| `spine_animate_constraint` | 给约束打帧（ik / transform / path），字段按 3.8.75 实测白名单过滤 | 否 |
| `spine_solve_constraints` | 诊断约束求解：IK 末端到 target 的收敛、order 冲突、约束是否真的生效 | 否 |
| `spine_inspect_atlas` | 只读解析 .atlas：页面、region、重叠、越界、缺图 | 否 |
| `spine_audit_assets` | 审计 skeleton 附件与图集 / 散图的对应关系 | 否 |
| `spine_export_workflow` | 批量导出工作流：多工程 × 多格式矩阵、自动生成设置、可选图集打包、统一产物报告、可选校验、dryRun | 是 |
| `spine_list_backups` | 只读列出写前备份清单（临时目录 spine-mcp-backups） | 否 |

## 写操作与人工重载（P0）

- 按项目约定，**不做自动重载**。所有会写 `.spine` 的工具（`spine_clean`、`spine_import_json`，以及 `spine_export` 的 `clean:true`）在成功后返回 `requiresManualReload: true` 与 `reloadHint`，提示在编辑器里手动 `Ctrl+O`；失败时不附加，避免误导。
- `spine_build_combat_animation` 写的是 JSON 副本，返回 `nextStep`，提示手动 `File → Import Data` 导入，不自动重载工程。
- `spine_make_export_settings` 只生成设置文件，不改 `.spine`；`json` / `binary` / `png` / `mov` / `avi` / `gif` 六种设置均已实测可用（详见 P9）。`settings.output` 只在数据导出里有意义，且会被 `spine_export` 的 `outputDir` 覆盖。
- `spine_project_info` 封装官方 `-i` Info 模式，只读；`parsed` 含 `spineVersion` / `dopesheetFps` / `skeletons`（骨骼、插槽、动画列表），解析不出来时为 `null`，原始 `stdout` 始终保留。

## P1：写前备份、多格式导出与产物校验

- **实测结论**：`spine_clean`（`-i -m`）会**原地改写** `.spine`（副本 10750 → 7994 字节、哈希变化），`spine_import_json`（`-r`）会生成新的 `.spine`，两者 exitCode 均为 0；官方 `-i` Info 也能直接读导出的 skeleton 数据文件（`Project info: null`，但骨骼 / 插槽 / 动画列表完整）。
- **写前备份**：`spine_clean` 默认 `backup: true`；`spine_import_json` 在 `overwrite: true`、`spine_export` 在 `clean: true` 时默认备份。备份落到系统临时目录 `spine-mcp-backups/`，不污染工程目录与 git 工作区，返回 `backupPath` / `backupHint`；显式 `backup: false` 可关闭。
- **多格式导出**：`spine_make_export_settings` 的 `format` 支持 `json` / `binary`（数据）与 `png` / `mov` / `avi` / `gif`（渲染）。binary 产物扩展名实测为 `.skel`；渲染产物的扩展名由设置 `class` 决定，设置里的 `extension` 会被忽略（P9 实测）。
- **`spine_verify_export`**：对源工程与导出目录里每个 `.json` 产物分别跑官方 `-i` Info，按 skeleton 名比对 `bones` / `slots` / `animations` 列表，返回 `ok` / `matched` / `missing` / `mismatches`。只读，但会多次启动 CLI，较慢。
- **批量导出**：`spine_export` 的 `extraInputs` 可追加多组 `-i/-e`；实测一次调用里混合 JSON 与 Binary 导出成功（exit 0）。
- 写操作成功后仍统一返回 `requiresManualReload` + `reloadHint`（手动 Ctrl+O），不自动重载。
- 尚未做：产物二进制内容级比对（当前只比结构）。图片 / 视频已在 P9 补齐。

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
- **仍有意排除**：产物二进制内容级比对、任何 GUI 自动化。

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

## P5：工程体检与动画时间轴工作流

- `spine_audit_project`：只读检查骨骼父子关系与循环、插槽/附件引用、mesh UV/三角形/权重、全部动画的骨骼/插槽/约束/deform/drawOrder 引用与事件定义；P8 起补齐 slots / IK / transform / path / deform / events / drawOrder 的时间合法性与严格递增检查。返回带 `severity` / `code` / 定位信息的 `issues`，不访问源图片、不写文件。官方 `raptor-pro.json` 实测 74 骨骼、36 插槽、5 动画，0 错误、0 警告。
- `spine_inspect_animation`：覆盖 bones / slots / IK / transform / path / deform / events / drawOrder，返回每条时间轴的关键帧、曲线类型、起止秒数和动画总时长；`includeKeyframes:false` 只取摘要，`maxKeyframes` 限制返回体量。兼容 Spine 导出时省略默认 `time=0` 的写法。
- `spine_edit_animation`：`duplicate` / `rename` / `remove` / `shift` / `scale` / `crop`；时间变换覆盖所有已识别时间轴并阻止负 time、重复或倒序关键帧。`crop` 只保留区间内现有关键帧，**不自动补边界插值帧**。
- `spine_merge_animations` 新增 `boneMap`（donor → base 骨骼映射）、`timeOffset`（所有关键帧秒数平移）、`skipMissingBones`（丢弃仍缺失的骨骼轨道并记录）；默认遇到缺失骨骼仍直接报错。
- 所有动画修改仍只写 JSON 副本并返回 `nextStep`（人工 Import Data）；`npm test` 61/61，通过官方 raptor 数据只读与副本复制验证，官方源文件哈希不变。

## P6：插槽、皮肤、约束与资源审计

- `spine_edit_slots`：`list` 只读；`add` 校验骨骼存在；`set` 只允许 `bone/attachment/color/dark/blend` 白名单字段；`rename` 同步改写皮肤 key、`animations.slots`、`deform` 与 `drawOrder.offsets`；`remove` 默认拒绝任何皮肤附件或动画引用，`dropAttachments` / `dropAnimationTracks` 需显式开启；`reorder` 要求给出全部插槽的新顺序，不得遗漏或重复。
- `spine_edit_skins`：`list` 只读；`add` 支持数组 / 对象两种 skins 形态并保持原形态；`assign` 按 `{ skin, slot, name, attachment }` 设置附件，`attachment:null` 表示删除；`rename` 同步 `animations.deform` 顶层 key；`remove` 默认拒绝仍被 deform 引用的皮肤，`dropDeformTracks` 显式开启后清理。
- `spine_inspect_constraints`：只读列出 IK / transform / path 约束、骨骼引用、缺失骨骼与被哪些动画时间轴使用；写入请用 P10 的 `spine_edit_constraints`。
- `spine_inspect_atlas`：解析 3.8 `.atlas` 文本，检查页面图片存在、region 重名 / 越界 / 重叠；`rotate:true` 的 region 按宽高互换后的页面占位做几何校验。
- `spine_audit_assets`：把 setup 与动画引用的附件和图集 / 散图对上：`mesh.path` 优先于附件名匹配 region；报告图集缺失 region、未被引用的 region 与散图缺文件；不提供 atlas 时跳过图集比对，不提供 imageDir 时跳过散图检查。
- 官方 `raptor` 实测：`raptor-pma.atlas` 1 页 38 region **0 问题**；39 个附件（含 `mesh.path`）**0 缺失、0 未用 region**；9 个 IK 约束 0 缺失骨骼。`npm test` **68/68**，官方源文件哈希不变。

## P7：导出工作流与写操作安全

- **`spine_export_workflow`**：一次调用完成「生成导出设置 → 批量导出 → 可选产物校验」。未提供设置时自动生成到**系统临时目录**，导出结束默认删除；`dryRun:true` 只返回计划，不建目录、不写设置、不调用 CLI。工作流**不开启 `cleanUp`**，不改动源工程。工作流只做 `json` / `binary`：它的 `-o` 是目录语义，而渲染导出的 `-o` 是文件基名，批量跑会互相覆盖，所以 `png` / `mov` / `avi` / `gif` 请直接调 `spine_export`（见 P9）。多工程矩阵与统一产物报告见 P11，图集打包串联见 P12。
- **binary 扩展名修正**：实测 3.8.75 的 `export-binary` 按 `extension` 决定产物名；此前设置里沿用 `.json`，产物内容是二进制但文件名误导。现已改为 **`.skel`**，并重新用官方 raptor 端到端验证。
- **官方 raptor 实测**：同一工程走一次工作流导出 JSON + Binary（2 个 job），产物 `raptor-pro.json`、`raptor-pro.skel`、atlas 与 png 齐全；`verify:true` 对 `.json` / `.skel` 分别跑官方 `-i` Info，**骨骼 74 / 插槽 36 / 动画 5 全部匹配，ok=true**；源 `.spine` 哈希不变。
- **写操作安全层**（`src/write-safety.mjs`）：所有 JSON 副本写操作统一走 `dryRun` 预览、顶层变更摘要（`changedSections` + 动画名级 added/removed/changed）、同目录临时文件 + rename 的**原子写入**；`overwrite:true` 覆盖旧输出前默认再备份一次并返回 `backupPath`。
- **`spine_list_backups`**：只读列出系统临时目录 `spine-mcp-backups/` 下的写前备份（文件、疑似原目标、大小、时间），配合 `spine_restore_backup` 形成备份闭环。
- `npm test` **73/73**。

## P8：收尾与端到端验证

- **全类型时间轴体检**：`spine_audit_project` 不再只检查骨骼和事件；slots / IK / transform / path / deform / drawOrder 的关键帧也检查 `time` 合法、严格递增与重复。官方 raptor 五个动画仍为 0 错误。
- **导出工作流报告准确性**：自动生成的导出设置位于临时目录并在返回前删除，响应现在明确标记 `retained:false`、`path:null`、`temporaryPath` 与 `temporarySettingsDeleted:true`，不再给出已失效的路径。
- **校验失败不掩盖导出**：导出成功后若 `verify` 因二次读取产物失败，返回 `verification.ok=false` + `error`，而不会把整个工作流标成失败。
- **真实 MCP stdio 端到端**：以子进程启动 `src/index.mjs`，走 `initialize` / `tools/list` / `tools/call`，确认 32 个工具可见、官方 raptor 体检 0 问题、JSON+Binary 混合导出成功、`verify.ok=true`、临时设置已清理。
- 官方源 `.spine` 与 `.json` 哈希均未变；`npm test` **73/73**。

## P9：图片与视频导出

三类导出设置都由 `spine_make_export_settings` 生成，类名从 3.8.75 字节码常量池读出后**逐个实测**：

| `format` | 设置 `class` | `exportType` | 产物扩展名 | 实测结果 |
|---|---|---|---|---|
| `json` | `export-json` | — | `.json` | 通过 |
| `binary` | `export-binary` | — | `.skel` | 通过 |
| `png` | `export-png` | `image` | `.png` | 通过（raptor 8 帧、3.89 MB） |
| `mov` | `export-mov` | `video` | `.mov` | 通过（464 KB，文件头 `ftypqt`） |
| `avi` | `export-avi` | `video` | `.avi` | 通过（21.9 KB，文件头 `RIFF…AVI `） |
| `gif` | `export-gif` | `video` | `.gif` | 通过（19.8 KB，文件头 `GIF89a`） |

- **最大的坑是 `-o` 的语义不同**：数据导出的 `-o` 是**目录**，渲染导出的 `-o` 是**文件基名**。传 `D:/out/raptor` 会得到 `D:/out/raptor.mov`；传 `D:/out` 会得到与目录同级的 `D:/out.mov`，目录本身是空的——这正是首轮实测「导出成功但输出目录为空」的原因。
- **例外**：`png` + `animationType: "all"` 时 `-o` 被当成目录，帧写进目录内，命名 `<skeleton>-<animation>_<帧号>.png`；`single` / `current` 时按文件基名处理，产出 `<基名>_<帧号>.png`。`outputPathKind()` 把这条规则显式化，工具返回值里直接给出。
- **`extension` 字段对渲染格式无效**：写 `.mp4` 也照样得到 `.mov` / `.avi`，容器由 `class` 决定，不要自己再拼后缀。
- **`spine_export` 现在会回报真实产物**：识别设置 `class` 属于渲染类后，按启动时间 + mtime 过滤，扫描「基名同级」与「基名目录内」两处，返回 `renderFormat` / `count` / `totalBytes` / `outputs[].path` / `scannedDirs`；一个都没找到时给出 `note` 说明原因，不再静默成功。渲染导出默认超时放宽到 600000 ms。
- **已验证可用的渲染参数**：`animationType`(`all`/`single`/`current`)、`lastFrame`（实测 raptor 的 png 由 8 张变 13 张）、`msaa`（4 可用）、`backgroundColor`（必须转成 `{r,g,b,a}` 对象，直接写十六进制会被 CLI 拒绝：`Unable to convert value to required type: background`）。
- **刻意不开放 `scale`**：实测它按「世界单位 → 像素」解释，`0.5` 会把 1281×1040 的图变成 13×11，与「相对自动适配的倍率」直觉完全不符，交给 CLI 自动适配更安全。
- **`spine_export_workflow` 不接渲染格式**：它的 `-o` 是目录语义，多个 job 会互相覆盖；渲染导出直接用 `spine_export`。
- `npm test` **81/81**。

## P10：约束参数修改

`spine_inspect_constraints` 只能看，`spine_edit_constraints` 补上写入（JSON 副本，工具总数 32 → 33）：

| `mode` | 行为 |
|---|---|
| `list` | 只读；`type` 可省略（返回三类），包含每条约束被哪些动画轨道引用、各多少帧 |
| `add` | 必须给 `bones` + `target`；name 在**同类**里唯一（`ik` 和 `transform` 是不同命名空间） |
| `remove` | 默认拒绝仍有动画引用的约束；`dropAnimationTracks:true` 才连带清轨道 |
| `rename` | 同步改写 `animations.ik` / `.transform` / `.paths` 的键名，避免留下被运行时忽略的孤儿轨道 |
| `set` | 只接受白名单字段，空变更给 warning 而不是静默成功 |

字段白名单来自官方 `examples/*/export/*.json` 的字段全集，不是按 4.x 猜的：

- `ik`：`order` / `bones` / `target` / `mix` / `bendPositive`
- `transform`：上述 + `skin` / `x` / `y` / `rotation` / `scaleX` / `scaleY` / `shearX` / `shearY` / `rotateMix` / `translateMix` / `scaleMix` / `shearMix`
- `path`：`order` / `bones` / `target` / `positionMode` / `spacingMode` / `rotateMode` / `rotation` / `position` / `spacing` / `rotateMix` / `translateMix`

枚举按实测收窄：`spacingMode` = `length`/`fixed`/`percent`/`proportional`，`rotateMode` = `tangent`/`chain`/`chainScale`（官方样本里出现过 `percent` 与 `chain`/`chainScale`）。

- **官方样本实测**：`raptor` 9 个 IK 改名后，`gun-grab` 里 1 帧的轨道跟着改名、旧名 0 残留；`spineboy` 的 `aim-head-transform` 四路 Mix 与 `rotation` 改值成功；`mix-and-match` 4 条 path 约束改名后顺序不变。
- 三个改后工程都跑了 `spine_audit_project`：**ok=true，issues 0**。
- 写操作仍走 `writeJsonCopy`，支持 `dryRun` / `overwrite` / 覆盖前备份；源 JSON 不改。
- `npm test` **87/87**（新增 `tests/p10-tools.test.mjs` 6 例）。

## P11：导出矩阵与统一产物报告

`spine_export_workflow` 从「单工程、单次 CLI 调用」扩成「多工程 × 多格式矩阵」：

```json
{
  "projects": ["D:/a/raptor-pro.spine", "D:/b/spineboy-pro.spine"],
  "formats": ["json", "binary"],
  "outputDir": "D:/out",
  "verify": true
}
```

- **矩阵**：`projects`（可继续用 `projectPath`）与 `formats`（可继续用 `format`）做笛卡尔积，每个「工程 × 格式」一个 job；同一工程重复传入会去重。
- **布局**：单工程时沿用原行为，产物直接落在 `outputDir`；多工程时每个工程一个子目录 `outputDir/<序号>-<工程名>`，避免两个工程里同名 skeleton 的 `.json` / `.skel` 互相覆盖。
- **逐 job 调用**：每个 job 单独启动一次 CLI（不再合成一次多组 `-i/-e`），这样产物可以按 job 归属，mtime 也能精确过滤本次新增文件。
- **统一报告**：`report` 给出 `jobCount` / `succeeded` / `failed` / `fileCount` / `primaryFiles` / `byproductFiles` / `totalBytes` / `byFormat`；每个 job 还有 `runs[].files`（含 `primary` 标记）与 `runs[].totalBytes`。
  - `primary` = 与该 job 格式对应的主产物（`.json` / `.skel`）；`atlas.txt`、`.png` 这类同目录附带产物记为 byproduct，按路径去重后只统计一次。
  - 同一文件在不同 job 眼里身份不同（json job 看 `.json` 是主产物、binary job 看它是附带产物），合并时取并集。
- **校验按目录去重**：`verify:true` 时每个输出目录只跑一次校验，多工程时返回 `verification.dirs[]`，`ok` 为各目录结果的与。
- **官方实测**：`raptor-pro` + `spineboy-pro` × `json` + `binary` 共 4 个 job，34 秒完成；`report` 为 8 个文件（4 主产物 + 4 附带产物）、2.9 MB；两个工程目录的 `verification.ok=true`，raptor 74 骨骼 / 36 插槽 / 5 动画、spineboy 64 骨骼 / 52 插槽 / 11 动画，`.json` 与 `.skel` 全匹配。
- `exportSettingsPath` 仍然只能用于单 job，多 job 场景请放进 `extraInputs[].exportSettingsPath`，否则无法判断该给哪个工程用。
- `npm test` **93/93**（新增 `tests/p11-workflow.test.mjs` 6 例）。

## P12：图集打包串联

`spine_export_workflow` 支持可选的 `pack` 步骤，一次调用拿到完整运行时包（数据 + 图集 + 页图片）：

```json
{
  "projectPath": "D:/proj/raptor-pro.spine",
  "outputDir": "D:/out/runtime",
  "formats": ["json", "binary"],
  "verify": true,
  "pack": {
    "imageDir": "D:/proj/images",
    "settingsPath": "D:/Spine/examples/export/atlas-0.5.json",
    "name": "raptor",
    "projectPaths": ["D:/proj/raptor-pro.spine"]
  }
}
```

- 参数映射到官方 `-i <图片目录> [-j 工程]... -o <目录> -n <图集名> -p <设置|图集名>`；不给 `settingsPath` 时 `name` 必填，直接当图集名用。
- **打包是收尾步骤**：数据导出失败就不打包，避免把时间浪费在注定不完整的产物上。
- **打包目录**默认与 `outputDir` 相同；**多工程时必须显式给 `pack.outputDir`**，否则两个工程的图片目录会被混进同一个图集。
- **报告口径**：`report.pack` 只统计本次打包新增的 `.atlas` / `.atlas.txt` / `.png`，并排除已被数据 job 归属的同目录文件（否则导出自带的 `.atlas.txt`、`.png` 会被重复计数）。
- **失败原因不再丢失**：3.8.75 打包失败常以非零退出码 + stderr 表现，`error` 会给出 `Caused by: ...` 那一行，而不是 `null`。实测踩到的例子：
  ```
  Image does not fit within max page size 1024x1024 and edge padding 2*2,2*2: raptor-body[1264,465]
  ```
  官方脚本给 raptor 用的是 `atlas-0.5.json`（缩放 0.5），用 `atlas-1.0.json` 的 1024 页装不下 1264 宽的图。
- **打包失败不连累数据导出**：两者的成败分开记录——`success` 为整体结果，`runs[]` 与 `packResult` 各自带 `success` / `error`；`verify` 只看数据导出是否成功，打包失败时校验结果照常返回。
- **官方实测**：raptor 工程 `json + binary + pack`，20 秒完成；数据产物 2 个主产物 + 2 个附带产物（1.82 MB），打包产出 `raptor.atlas`（3.9 KB）与 `raptor.png`（479 KB），源 `.spine` 不变。
- `npm test` **98/98**（新增 `tests/p12-pack.test.mjs` 5 例）。

## P13：.skel 二进制结构级校验

数据导出的 `.skel` 是二进制，官方 `-i` Info 读不了，此前只能确认「文件存在」和「文件头正确」。P13 补上真正的结构级解析：新增 `src/skel-parse.mjs`（零依赖）与 `spine_inspect_skel`，并让 `spine_verify_export` 同时覆盖二进制产物。

读取顺序严格按官方 `SkeletonBinary`（3.8 分支，Java 与 TS 两端逐字段核对）：

```
header → 字符串表 → bones → slots → ik → transform → path
       → 默认皮肤 → 其它皮肤 → events → animations
```

**核心判据是「读到文件末尾恰好耗尽字节」**——`consumedBytes === bytes` 才说明整棵树在字节层面自洽；一旦某个字段读法有偏差，后续必然错位，几乎不可能刚好落在 EOF 上。因此 `trailingBytes > 0` 直接判为 error。

- **格式要点（踩过的坑）**
  - `readString`：变长整数存「字节数 + 1」，0 表示 `null`，1 表示空串；`readStringRef` 是字符串表下标，0 表示 `null`。
  - `readInt(optimizePositive)` 是 7 位变长；`optimizePositive=false` 时按 ZigZag 解码（事件 `intValue` 用这种）。
  - `float` / `int32` / `short` 全部**大端**。
  - **附件名要读两次**：`readSkin` 先读一次，`readAttachment` 内部再读一次，后者为 0 时**回退到前者**（不是再读一个字符串）。这一点 TS 版转述容易写成 `readString()`，按 Java 原实现才对。
  - `varint` 长度前缀里，**时间线帧的曲线**只在 `frameIndex < frameCount - 1` 时读；`byte=2`(BEZIER) 追加 4 个 float，`0`(LINEAR) / `1`(STEPPED) 不追加。
  - 事件时间线是否读 `volume`/`balance`，取决于 **events 段**里该事件有没有 `audioPath`，不是每帧一个标志位。
- **`spine_inspect_skel`**：`detail=false` 只回 `counts`、每个动画的 `duration` / 时间线条数与 `issues`；`detail=true` 额外给完整骨骼 / 插槽 / 约束明细。不调用 CLI，纯本地解析。
- **引用完整性检查**：骨骼父级必须指向更早的骨骼；插槽骨骼、IK / transform / path 的 `bones` 与 `target`、皮肤引用的骨骼与约束、动画里各时间线的索引、Deform 时间线引用的附件，全部做越界校验，问题进 `issues` 而不是抛异常。
- **`spine_verify_export` 升级**：`.json` 仍走官方 `-i`（与源工程同口径），`.skel` 走本地解析；二进制文件内没有 skeleton 名字，按文件名推导，对不上时若源工程只有一个 skeleton 就认它（`matchedBy: "sole-skeleton"`）；`includeBinary=false` 可关掉。产物结构自检失败会进 `binaryProblems` 并拉低整体 `ok`。
- **`-i` Info 解析补齐 `IK constraints`**：否则二进制侧有 IK 名字、源工程侧为空，会产生假差异。
- **官方实测**：raptor / spineboy / mix-and-match / stretchyman / tank / alien / vine / owl 共 8 个工程导出二进制后全部 `trailingBytes=0`、`errorCount=0`；骨骼 / 插槽 / IK / transform / path / 皮肤 / 附件 / 事件 / 动画计数与对应 JSON 全部一致（`mix-and-match` 34 皮肤 373 附件、`tank` 200 插槽、`spineboy` 80 附件均对上）。`raptor` 的 JSON + Binary 同目录混合校验 `ok=true`，把 `.skel` 截掉 40 字节后 `ok=false` 并指出越界偏移。
- `npm test` **108/108**（新增 `tests/p13-skel.test.mjs` 10 例，内含一个精简 `.skel` 编码器，用手工构造的「已知答案」字节流验证解析，不依赖 CLI）。

## P14：面片结构明细与渲染预览（双通道评审）

面片这一层此前只有「合法性校验」和「权重数值」两个视角，看不到某个 mesh 实际怎么连、被哪些骨骼拉。P14 补上结构通道与视觉通道：

| 通道 | 工具 | 特点 |
|---|---|---|
| 结构（首选） | `spine_inspect_mesh` | 纯 JSON 解析，秒级、零渲染、不调 CLI |
| 视觉（兜底 / 对照） | `spine_render_preview` | 真调 CLI 出图，几秒到几分钟 |

**默认策略**：先用 `spine_inspect_mesh`；它报错或需要确认画面时再用 `spine_render_preview`。**全面评审时两者同时调用**——把结构数据（面片数、顶点数、权重骨骼）与实际渲染帧对照，对不上就说明工程里有结构问题或导出设置不对，再针对性调整。

### spine_inspect_mesh

```json
{ "jsonPath": "D:/out/citizen_001.json", "detail": "weights", "bone": "bone_head", "limit": 20 }
```

- `detail`：`summary`（默认，只要统计）/ `faces`（附三角面索引）/ `weights`（附逐顶点权重）。
- `mesh`：只看一个面片，支持 `附件名` 或 `插槽名/附件名`。
- `bone`：按骨骼反查——这根骨骼影响了哪些面片、多少顶点、权重和多少。排查变形问题时比看总数有用。
- 自查项：uvs 长度、顶点数 ≥ 3、`triangles` 是否 3 的倍数、三角面下标越界、权重和是否等于 1、权重引用的骨骼下标是否存在。问题进 `issues`，不抛异常。
- **3.8 的 `skins` 是数组** `[{name, attachments}]`，不是字典。按字典遍历会得出「0 个 mesh」这种完全错误的结论（踩过）。

### spine_render_preview

```json
{ "projectPath": "D:/proj/citizen_001.spine", "outputDir": "D:/out/preview", "format": "png", "backgroundColor": "#202020" }
```

- 不需要预先准备 `export-settings.json`：内部生成 → 调 CLI → 回收产物 → 删临时设置，`settings.removed=true` 可确认。
- 参数：`format`（png/mov/avi/gif）、`animationType`（all/single/current）、`lastFrame`、`msaa`、`backgroundColor`、`timeoutMs`、`dryRun`。
- `-o` 语义沿用 P9：png + `animationType=all` 时当**目录**，其余是**文件基名**（内部用工程名当基名）。
- 默认只出每个动画的首帧；要每一帧加 `lastFrame: true`。
- **浅色美术一定要换背景**：实测白底导出 citizen_001 几乎全白、看着像「没渲染」，换 `#202020` 后能看到完整角色并确认贴图正常。默认白底在这个场景会误导判断。
- 失败时回传 `error`（取 `Caused by` 那行）与已扫描目录，不静默成功。

**官方实测**：`citizen_001` 16 个 mesh / 76 顶点 / 46 三角面，全部加权；`bone_head` 影响 `face`、`neck`、`hair` 三个面片共 12 个顶点、权重和 11.7615。`spine_render_preview` 出 6 张 png（141×115 等），4.9 秒，文件名形如 `citizen_001-Idle_Normal_Test_001_0.png`，与 `body.png` 的米黄配色一致，结构数据与渲染结果吻合。

`npm test` **119/119**（新增 `tests/p14-mesh.test.mjs` 11 例，覆盖统计、面片 / 顶点明细、骨骼反查、拓扑异常、双 skin 格式兼容、`-o` 语义与 dryRun 不落盘）。


## P15：动画采样与线框叠加校验

P14 解决了「面片是什么」，但**画面和结构数据对不上时无法定位**：`spine_inspect_mesh` 给的是 setup pose 的静态结构，而渲染图是动画某一帧，两者本来就不该完全重合。P15 补上中间那层——把「某一时刻的骨架姿态」算出来。

两个新工具都是**纯本地计算**，不调 CLI、不写工程：

| 工具 | 干什么 |
|---|---|
| `spine_get_wireframe` | setup pose 或 `animation` + `time` 时刻 → 骨骼世界变换 / 面片顶点世界坐标 / region 可见四边形，可直出 SVG 或自包含 HTML |
| `spine_align_check` | 把线框等比贴合到渲染图前景，算出**可比较的数字**，而不是靠肉眼说「看着差不多」 |

### 3.8 的三个数值语义（都踩过）

| 事实 | 后果 |
|---|---|
| 时间线值是**相对 setup pose 的偏移**：rotate / translate / shear 相加，scale 相乘 | 按绝对值算会把骨骼翻到另一侧。`bone_arm_r_01` setup=180°、首帧 `rotate.angle=-10.06` → 169.94°；取 -10.06° 手臂直接反向 |
| 贝塞尔控制点**不在数组里**：`curve` 是 cx1，另三点在同级字段 `c2`/`c3`/`c4`，默认 `0/1/1` | 按 4.x 的四点数组写，导入时直接报 `IllegalStateException: Value cannot be converted to float: array`，整个骨架导不进去（不是静默降级）。`spine_build_combat_animation` 的 `curve` 仍接受四元数组，但内部会翻译成 3.8 原生编码 |
| `bones[].parent` 是**骨骼名字符串**，不是下标 | 按 `world[parent]` 取会全部 `undefined`，每根骨骼都被当根骨骼，只保留局部坐标 |
| region 的 `width/height` 是**未裁剪帧**尺寸 | 武器 `128×128` 实际只露 `42×6`，按整帧画包围盒会被撑成两倍高 |
| `-r` 导入**只导骨架数据，不带图集** | 导进去的骨架槽位/动画都在，但渲染全是 MISSING 占位图；把 atlas/png 放到同目录、改名对齐、按 `skeleton.images` 写相对路径三种摆法都试过，均无效。图集只能在 GUI 里关联 |
| `-r` **不能替换同名骨架** | 目标工程已有 `citizen_001` 时再导入同名骨架，会被自动改名成 `citizen_1` 而不是覆盖；CLI 没有 replace 开关，加动画只能得到「原骨架 + 变体骨架」两个 |

### 对齐校验怎么打分

1. 取渲染图前景盒（有 alpha 走 alpha，不透明背景走「与角落颜色差」）；
2. 把线框**内容盒**（只含面片顶点 + region 可见四角，不含骨骼）等比映射到前景盒；
3. 统计三项：骨骼沿线 25 点命中率、面片重心命中数、三角面覆盖掩膜与前景掩膜的 **IoU**。

IoU 是关键——命中率只能证明「落在轮廓里」，IoU 能区分「姿态算对了」和「碰巧压在色块上」。

**官方实测**（`citizen_001`，43×61 像素前景）：

| 场景 | IoU | 骨骼命中率 | 面片重心 |
|---|---|---|---|
| setup pose | 0.814 | 0.988 | 16/16 |
| `Idle_Normal_Test_001` @ 0s | **0.928** | 0.990 | 16/16 |
| `Idle_Normal_Test_001` @ 1.0s（对第二帧渲染图） | **0.927** | 1.000 | 16/16 |
| `Attack_Sword_Test_Light_001` @ 0s | 0.915 | 1.000 | 16/16 |
| `Run_Normal_Test_001` @ 0s | 0.881 | 0.995 | 16/16 |

同一张图上 setup 0.814 → 动画首帧 0.928，这就是采样引擎正确性的直接证据（差 11 个点，远超噪声）。

### 用法

```jsonc
// 看某个时刻的线框，直接落成可打开的页面
{ "jsonPath": ".../citizen_001.json", "animation": "Attack_Sword_Test_Light_001", "time": 0.4,
  "format": "html", "outPath": "D:/out/attack.html" }

// 先出图，再对着算
{ "jsonPath": ".../citizen_001.json", "renderPng": ".../citizen_001-Idle_Normal_Test_001_0.png",
  "animation": "Idle_Normal_Test_001", "time": 0, "outHtml": "D:/out/align.html" }
```

- `atlasPath` 不传时会在 JSON 同目录自动找 `同名.atlas.txt` / `同名.atlas` / 目录下任意 atlas；都找不到也能画，只是 region 按完整帧算、包围盒偏大。
- `format: "summary"` 只给统计与坐标，不产 SVG，适合只想拿到世界坐标的场景。
- 两条命令都不需要 `SPINE_EXE`。

### 当前没做的（会明确写进 warnings）

- **deform 时间线**：检测到就告警，但**不参与**顶点位移计算，所以变形动画的线框会和渲染有偏差。
- **path 约束**：3.8 的 path 约束要 path 附件的贝塞尔几何，采样引擎不构建它，所以路径上的骨骼位置仍按层级算（IK / transform 已在 P16 求解）。
- **inherit 非 normal**（`onlyTranslation` / `noScale` 等）：按 normal 算并告警。
- **drawOrder**：只影响绘制顺序，不影响几何，直接忽略。

`npm test` **178/178**（P15 的 `tests/p15-pose.test.mjs` 27 例覆盖时间线采样、世界变换累乘、region 裁剪与 IoU；P16 的 `tests/p16-constraint.test.mjs` 30 例覆盖约束求解与打帧）。

## P16：约束求解与约束打帧（3.8.75 的「动态约束」到底是什么）

先回答版本问题：**3.8.75 没有物理（physics）约束**，那是 4.2+ 才有的东西——把 `"physics": [...]` 写进 JSON 导入不报错，但导出时被**静默丢弃**（三处独立验证：另一个工程、IK 对照工程、官方 14 个示例）。3.8 只有 `ik` / `transform` / `path` 三类。

但「运行时动态变化」这件事 3.8 是支持的，只是它是**参数驱动**：三类约束的 mix / position 都能被动画打帧。所以 P16 做两件事——把约束按 3.8 语义**求解**进采样引擎，再把「给约束打帧」做成工具。

### 求解：IK / transform 已接入采样

`spine_get_wireframe` / `spine_align_check` 返回的 scene 现在带 `constraints` 报告，逐条给出该时刻的 `values` / `before` / `after` / `changedBones` / `movedBones`。语义上踩过的点：

- **约束按 `order` 升序求解**，同 order 保持定义顺序；每解完一条必须重算受影响骨骼的**整棵子树** world 变换，否则「骨头动了肉没动」。
- **IK 追的是 target 骨骼的世界原点**，不是骨骼末端。两骨链用余弦定理；单骨只转骨轴（骨比距离长就会伸过头，属正常行为，不是解错）。
- **IK 只按前两根骨骼求解**，多骨链会告警并说明其余被忽略。
- **`transform` 的四个 mix 默认值都是 1**：官方 `alien` 的 `eye` 约束只写了 `x/y` 偏移没写 mix，`death` 动画里显式打 0 才能关掉它——证明不写 = 全量生效。
- **世界剪切 = Y 轴角 − X 轴角 − 90**。这里踩过一个真坑：早期写成 `atan2(t.c,t.a)+90-worldRotation(t)`，两项恒抵消成 90°，会把骨骼 `shearY` 顶到 90° 并拖歪整棵子树（alien 的 `eye-root → eye`，`eye` 世界 x 从 51.29 变成 -185.67）。

验证不靠肉眼也不靠渲染：官方 `raptor` 有 9 条 IK，沿 5 个动画、41 个时间点扫一遍，**臂展内的约束末端误差 ≤ 0.8 单位**（骨架跨度约 1100），关掉求解时同批约束最大偏差 474 单位。`transform` 用 `alien` 的 3 条约束验证：setup 姿态下 rotateErr / posErr / 缩放比 / 剪切误差**全部 0.000**，`death` 动画把 mix 打到 0 时位移正好归零。

### 打帧：`spine_animate_constraint`

字段白名单是**实测**出来的（写进 JSON → `-r` 导入 `.spine` → 再导出 JSON，看谁活下来），不是照抄文档：

| 约束 | 时间线位置 | 能打帧的字段 | 被丢掉的字段 |
|---|---|---|---|
| `ik` | `animations.<动画>.ik.<约束名>`，**数组** | `mix`、`bendPositive` | `softness` |
| `transform` | `animations.<动画>.transform.<约束名>`，**数组** | `rotateMix`、`translateMix`、`scaleMix`、`shearMix` | `rotation` / `x` / `y` 等偏移 |
| `path` | `animations.<动画>.path.<约束名>`，**对象**，分两通道 | `position` 通道 → `position`；`mix` 通道 → `rotateMix` / `translateMix` | `spacing` |

白名单外的字段直接报错（错误里列出可用字段），不会写出导不回去的 JSON。省略的字段按 3.8 默认值处理，因此不会落到文件里。

`curve` 支持 `"stepped"` / 数字 cx1 / 4 元数组（内部翻译成 3.8 原生的 `curve` + `c2/c3/c4`）。但 **`transform` 约束时间线写 `"stepped"` 会让 3.8 导入抛 `ArrayIndexOutOfBoundsException: 19`**，整份骨架都进不去——这条已做成硬拒绝。

端到端往返实测（工具写出 → `-r` 导入 → 导出 JSON）：`transform` 四个 mix、`path` 的 mix 通道合并（保留原有帧 + 新增帧）、`ik` 的 mix 与贝塞尔，全部原样保留。

### 诊断：`spine_solve_constraints`

沿动画时间线采样，逐条回报生效次数 / 位移骨骼数 / 该时刻的动画字段 / 该类型能打帧的字段。判定项：

- `ik.not-reached`：目标在臂展内但末端没闭合（求解读不对才会出现）。
- `ik.axis-off`：单骨 IK 的骨轴偏离 target。
- `ik.out-of-reach`：target 一直在臂展外（链恒为完全伸展，正常但值得知道）。
- `ik.mix-never-full`：mix 从没到 1（末端本来就贴不上，属预期，不报错）。
- `constraint.order-collision`：同 order 且骨骼链有交集，结果依赖定义顺序。
- `ik.no-effect` / `transform.no-effect`：全程没产生位移（最常见是 mix 被动画打成 0）。
- `path.unsolved`：path 约束未参与求解。

用法：`spine_solve_constraints { jsonPath, animationName: "walk" }` 看整条动画的收敛情况；`solve:false` 作为「不求解」基线做对比。

### 伪 3D 转身：约束能表达什么、不能表达什么

场景：`citizen_001`（17 骨骼 / 全 mesh 蒙皮，躯干朝上 rotation≈90°）要做「小幅转身」的类 3D 效果。做法是一根控制骨 `turn_ctrl`（parent `root`）+ 六条 transform 约束，全部静态 mix 默认 0（setup 零侵入），转身幅度只由控制骨的旋转曲线决定，mix 曲线只决定「哪一层跟多少、什么时候跟」。

| order | 约束 | 驱动骨骼 | 静态参数 | 时间线 |
|---|---|---|---|---|
| 0 | `turn_hip` | `bone_body_01` | rotation +1.35 | rotateMix 0→0.20 |
| 1 | `turn_chest` | `bone_body_02` | — | rotateMix 0→0.85 |
| 2 | `turn_neck` | `bone_neck` | — | rotateMix 0→0.95 |
| 3 | `turn_head` | `bone_head` | rotation +0.71 | rotateMix 0→1.0 |
| 4 | `turn_squash` | `bone_body_02` | scaleY −0.08 | scaleMix 0→1 |
| 5 | `turn_squash_hip` | `bone_body_01` | scaleY −0.06 | scaleMix 0→1 |

实测（峰值帧 t=0.467，控制骨 −16°）：

| 指标 | 单层硬转（只转腰、mix=1） | 分层约束 |
|---|---|---|
| 腰 / 胸 / 颈 / 头 世界转角 | −16.0 / −16.0 / −16.0 / −16.0 | −3.2 / −13.4 / −15.0 / −15.1 |
| 头腰夹角 | 0° | 11.9° |
| 腿部宽度比（剪影） | 1.212（被甩开） | 0.945（基本保持） |
| 脚部漂移 | 7.43 单位 | 1.63 单位 |
| 首末帧与 setup 的偏差 | — | 0.0001 |

**层间梯度只能靠 mix，不能只靠 rotation 偏移**：`transform` 的 `rotation` 语义是「对齐到 target 的世界角 + 偏移」的绝对量，写死偏移只会让各层保持固定夹角；要让层次在时间上拉开、收拢，必须给每层打不同的 mix 曲线。级联顺序（头先到、腰后到）比齐步到位更像真实转身。

**压缩轴别搞反**：`transform` 的 `scaleX` 压的是**骨骼长度方向**，`scaleY` 压的是垂直方向，都不是世界 XY。这个角色躯干 rotation≈90°，所以 `scaleX:-0.12` 实际压的是**身高**（全高比 0.947），`scaleY:-0.12` 才是压肩宽（0.895）。另外压在 `body_01` 上会把整条腿一起压，脚底被抬起 3.13 单位；压在 `body_02` 上脚部位移是 **0.00**。

**做不到的**：2D 骨骼旋转等于倾斜，不等于转身。幅度一大，头就是「歪」而不是「转过去」——脸是单一 mesh，没有左右侧信息。要继续逼真只能上 deform 或做左右半脸/半身的附件切换。

## 与 GUI 联动（方案 C）

### 写操作前先查「GUI 正开着哪个工程」（新工具 `spine_gui_status`）

这是硬规则：**任何会写 `.spine` 的操作之前，先确认目标工程就是 GUI 当前打开的那个**，否则极易改错文件。

```json
{ "projectPath": "C:/path/to/project.spine" }
```

返回 `guiRunning` / `pid` / `windowTitle` / `projectName` / `dirty` / `matchesCurrent` / `warnings`。传 `projectPath` 时若它不是当前打开的工程，`warnings` 里会明确提示。

**判据是窗口标题，不是文件 mtime**：打开工程是只读操作，不落盘也就不改 mtime；只有保存才写。实测反例：`spinemcp_test.spine` 的 mtime 停在 01:50，而窗口从 19:59 一直开着它；同一目录下另一个 20:45 刚保存的工程反而不是当前打开的。用 `ls` 的时间戳去猜当前工程，就等于把「最后保存过」当成「正开着」。

实现走 `tasklist /v /fo csv` 的**窗口标题列**（零依赖、不截图、不模拟 UI），用 `TextDecoder("gbk")` 解中文 Windows 的 OEM 输出。标题格式 `Spine - <工程名>`（无扩展名），所以**只能按文件名比对，同名不同目录区分不了**——这点在返回的 `hint` 里有说明。未保存标记按标题里的 `*` 识别：Spine 3.8.75 实测是放在**工程名前**（`Spine - *Turn_AnimTest`），其他 Java 应用可能放尾部；两种位置都会置 `dirty=true`，并去掉 `*` 后再比对工程名，避免误判成「不是当前工程」。

除了显式调用，`spine_import_json`（含 `replaceProject`）、`spine_clean`、`spine_reload_gui` 现在都会自动附一个 `gui` 字段：GUI 没运行、目标不匹配、可能有未保存改动时都能从返回里直接看到，不需要额外调用。

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
- **本机实测（3.8.75，2026-11-16 复核，推翻了早期结论）**：GUI 已运行时再启动 `Spine.exe <工程路径>`，新进程会把路径**转发给已有实例**后自行退出，原窗口随即加载该工程——窗口标题从 `Spine` 变成 `Spine - 工程名`。本次实测：原实例 pid 14876 标题由 `Spine` 变成 `Spine - spinemcp_test`，新起的 9332 在几秒内退出。所以单实例锁的表现是「转发」而不是「拒绝」，工程是能被打开 / 切换的；早期以为的「不转发」是只看了新进程存活与否，没看原窗口标题。
- **锁探测不可靠**：Spine 是 Java 应用，`.lock` 走 java.nio 区间锁，不独占文件句柄，所以 `detectGuiLock` 的 `r+` 探测在有 GUI 时依然成功，**判断不出「GUI 正在运行」**。该字段只作参考，不用于阻断启动。
- **默认放行**：`allowWhenRunning` 默认 `true`，直接 spawn 即可，转发由 Spine 自己完成；传 `false` 恢复保守行为，探测到锁被占用就返回 `blocked: true` / `launched: false` 与 `hint`，不产生进程。启动成功时返回 `verifyHint`，提示用窗口标题确认是否真的打开。
- 仍然成立：CLI 写盘后 GUI **不会自动刷新**（没有 watch / reload 参数），需要主动调用本工具或手动 `Ctrl+O`；GUI 里若有未保存改动，先 `Ctrl+S`，否则重新打开会被磁盘版本覆盖。
- **不模拟鼠标键盘、不读写工程文件、不自动保存**。
- 文件监听式自动重载（检测到 `.spine` 变化就自动触发）尚未实现，避免后台抢焦点，可作为后续扩展。

### 把改动直接落进 GUI 正开着的工程（`replaceProject`）

**先讲清两条硬限制**，别指望「原地改同一个骨架」：

1. `.spine` 不是 JSON，是 **raw deflate 压缩的二进制序列化**（解压 90~96 KB，能看到 `3.8.75`、骨架名、`../images/...` 之类的字符串片段，但整体是 Spine 私有布局）。想加一条约束就得重写整份二进制；实测同一份数据由 GUI 保存和由 CLI 生成，解压后**布局完全不同**（71463 字节差异、字段顺序错位），所以「定位几个字节改掉」也不可行。
2. CLI 的 `-r` 导入**只能新增骨架**：目标工程已有同名时强制改名（实测 `Skeleton renamed: skeleton -> skeleton2`），没有任何 replace 开关。`--help` 里 Import 只有 `-i / -s / -o / -r [name]` 四个参数。

所以「原地改」只能走**重生整个工程**：`spine_import_json { inputPath, outputPath, skeletonName, replaceProject: true }` 会先把导入结果写到同目录的 `<名>.importing.spine`，CLI 成功后才用它整体替换 `outputPath`（替换前自动备份到系统临时目录）。CLI 失败时目标文件**一个字节都不动**，临时文件自动清理。

配合 `spine_reload_gui` 就是全程零人工：写盘 → 让 GUI 重新加载 → 窗口里直接是新版本。

代价（实测，无法绕过）：

| 内容 | CLI 重建（`replaceProject`） | GUI 的 File → Import Data |
|---|---|---|
| 骨骼 / 槽位 / 皮肤 / 事件 / 约束 / 动画 | 全部保留 | 全部保留 |
| 图片与音频路径 | 保留 | 保留 |
| 骨架画布尺寸（Skeleton Size） | **变成 unknown** | 保留 |
| 人工操作 | 0 步 | 4 步 |

尺寸丢失的根源是 CLI 的 Import 根本不读 JSON `skeleton` 块里的 `x/y/width/height`（GUI 的导入器才读）。它只影响编辑器取景，不影响骨骼数据和导出；在 GUI 里设一次即可。

**安全边界**：`replaceProject: true` 要求 `outputPath` 已存在（否则直接报错，不会误建文件）；替换前一定备份；执行前请让用户在 GUI 里 `Ctrl+S`，否则未保存改动会被重载覆盖。

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
- **没有 physics 约束**：`"physics": [...]` 写进 JSON 导入不报错，导出时被**静默丢弃**。3.8 只有 `ik` / `transform` / `path`。
- **`bones[].parent` 是名字字符串**，不是下标；按数组下标取会全部 undefined，每根骨骼都变根骨骼。
- **`transform` 约束时间线写 `curve: "stepped"` 会让导入崩溃**：`java.lang.ArrayIndexOutOfBoundsException: 19`，整份骨架进不去。`ik` / `path` 的 stepped 正常。
- **约束时间线的字段比定义少**：ik 只有 `mix` / `bendPositive`（`softness` 打不进）；transform 只有四个 Mix（`rotation` / `x` / `y` 偏移不是时间线字段）；path 的 `position` 通道只有 `position`（`spacing` 打不进）。
- **path 约束的动画键名是单数 `path`**，值是 `{ position: [...], mix: [...] }` 的对象；`ik` / `transform` 的时间线却是**直接一个关键帧数组**，没有通道层。
- **约束 `order` 必须从 0 开始且跨类型连续**：3.8 导入器按「数组位置」重建序号，手写 `order: 1..n` 会抛 `java.lang.RuntimeException: Missing constraint order: 0`，整份骨架都进不去。`spine_edit_constraints` 现在写完会按 ik → transform → path 的数组顺序重排成 0..n−1，并在 `summary.reordered` 里回报（order 0 按 3.8 导出习惯省略字段）。
- **`curve:"stepped"` 不一定是错误**：3.8 导出时会把「两端值相同」的常量段写成 `curve:"stepped"`，这在语义上就是常量，采样无差异（往返实测最大 0.006°）。把**有变化**的段写成 stepped 才会崩，见上一条。
- **`transform` 的 `scaleX` 压骨骼长度方向、`scaleY` 压垂直方向**，不是世界 XY；对朝上的躯干，只有 `scaleY` 才是「横向压缩」。
- **判断 GUI 正打开哪个工程，用窗口标题 `Spine - <工程名>`，不要用文件 mtime**：打开不写盘、mtime 不变；正确判据是 `tasklist /v /fo csv` 的窗口标题列（`spine_gui_status` 已封装）。
- **CLI 导入不写骨架画布尺寸**：`-r` 生成的骨架一律 `Size: <unknown>`，JSON 里的 `skeleton.width/height` 会被忽略；只有 GUI 的 File → Import Data 会读。
- **3.8 的贝塞尔控制点不是四点数组**：`curve` 存 cx1，cy1/cx2/cy2 落在同级 `c2`/`c3`/`c4`（默认 0/1/1）。传数组会报 `IllegalStateException: Value cannot be converted to float: array`。
- stdio 的 stdout 只输出 MCP 消息，日志全走 stderr；配置后若显示「暂无工具」需重启客户端。

## 协议兼容

- **legacy**（2025-11-25 及更早）：响应 `initialize`，支持 2025-06-18 / 2025-03-26 / 2024-11-05。
- **modern**（2026-07-28）：实现强制的 `server/discover`，每请求读 `_meta` 的 `io.modelcontextprotocol/protocolVersion`；不支持的版本返回 `-32022` 并列出 `supported`。
- 空能力查询 `resources/list`、`prompts/list` 返回空集，避免部分客户端报错。

## 能力边界（如实列出）

- 不替代 Spine 编辑器、不绕过商业授权；不做鼠标键盘模拟、窗口自动化、时间轴拖动、mesh 封套编辑、编辑器里刷权重、预览渲染。骨骼**结构与 setup pose 数值**（`spine_modify_bones`）、**网格权重数值**（`spine_edit_weights` 的 inspect / normalize / scale）以及**约束参数**（`spine_edit_constraints`）都可在 JSON 副本上修改（P4 / P4b / P10），但编辑器里的交互式骨骼 / 权重操作仍不支持。GUI 联动只通过 `spine_reload_gui` 调用官方 Editor 模式请求重新打开工程。
- `.spine` 的一切改动只经官方 CLI；动画生成只写 skeleton JSON 副本，**不直接改 .spine 二进制**。
- CLI 参数构造依据 1425sd/spine-MCP 项目记录的 3.8.75 用法；本机已端到端验证 `--help`、`-i` 只读 Info、`spine_export`（`json` / `binary` 副本真实导出，exitCode 0）、`spine_import_json`、`spine_clean`，以及「导出 → `spine_inspect_json` → `spine_build_combat_animation` → `spine_validate_timeline`」全链路；多 `-i/-e` 批量导出（混合 JSON / Binary）、图集 pack / unpack、以及 `-r` 导入另一个工程的 skeleton 均已实测；P3 的 diff / 合并 / 事件管理 / 批量生成、P4 的骨骼修改、P4b 的权重数值、P5 的体检 / 动画明细 / 动画编辑、P6 的插槽 / 皮肤 / 约束检查 / 图集资源审计、P7 的导出工作流 / 写操作安全层、P8 的全类型时间轴体检 / 工作流报告修正、P9 的 png / mov / avi / gif 渲染导出、P10 的约束写入、P11 的导出矩阵 / 统一产物报告、P12 的图集打包串联、P13 的 `.skel` 二进制结构级解析与 P14 的面片结构明细 / 渲染预览均由离线单测覆盖，并额外通过真实 MCP stdio 会话跑通全部新工具（渲染导出实测产出 8 张 png、`.mov`、`.avi`、`.gif` 且文件头正确）；**未验证**：渲染画面与结构数据的自动比对——P14 已能把结构数据和渲染帧都拿到手，但「哪里对不上」仍需人（或模型看图）判断，没有做像素级回归。产物二进制已进 P13，`.skel` 的字节级结构（含引用完整性）会真解析到文件末尾并逐项校验。协议层与纯逻辑层已跑通自动化测试。
- 约束侧：`ik` / `transform` 可按 3.8 语义求解（含 order 排序、时间线 mix），`path` **不求解**（缺 path 附件的贝塞尔几何）；约束时间线可打帧，但只限各类型实测支持的那几个字段。物理（physics）约束 3.8 本身没有，MCP 自然也不支持。
- 无图集拆分 / 自动绑骨 / 预览渲染 / Cocos 扩展，这些是后续可扩展项，不是本版能力。
