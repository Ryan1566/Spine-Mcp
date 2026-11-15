# AGENTS.md — spine-mcp 协作须知

这个仓库主要由 **WorkBuddy** 开发；其他 agent（含 DSH / Codex）按需提建议、打补丁、做独立验证。改动前先读本文，别重复别人已经做完的方案。

## 动手前（每次都要）

1. `git -C D:/Spine-Mcp status --short` + `git -C D:/Spine-Mcp log -3 --oneline`：先看有没有别人刚提交或正在改的东西。
2. `node D:/Spine-Mcp/scripts/check-update.mjs`（等价 `npm run check`）：比对「磁盘上的源码」和「正在跑的 MCP 进程」。
   - 退出码 `0`：一致，可以放心用工具。
   - 退出码 `1`：**进程落后于磁盘**，先重载再调用工具，别拿旧进程的结果当验证结论。
   - 退出码 `2`：没发现活实例，先确认宿主已连上（`spine_doctor` 能返回就是连上了）。
3. 读 `.workbuddy/memory/MEMORY.md`：WorkBuddy 记录的项目约定、环境事实与已验证/未验证清单。

> 为什么需要第 2 步：MCP server 是宿主 spawn 的独立进程，`src/*.mjs` 改了它不会热更新，也不报错，只会「工具行为对不上」（典型现象：磁盘上有 9 个工具，会话里只见 8 个）。

## 重载 MCP（改完 `src/` 之后必须做）

- DSH：`plugin_manager set_plugin(include:mcp-spine, enabled:false)` → 再 `enabled:true`；或重启 DSH。
- WorkBuddy：重连 `mcpServers["spine-mcp-local"]`。

## 改动约定

- 新增/删除工具时同步三处：`src/tools.mjs` 的 `TOOLS` 数组、README 的工具表、`tests/` 里至少一条用例。
- 跑测试：`npm test`（内部会 spawn 子进程；DSH 沙箱内需提权，否则 `spawn EPERM`）。
- 不自行 `git commit`：提交权在 WorkBuddy 手上，避免把对方未完成的工作一起提交。
- 写操作分寸：`spine_clean` 原地保存源工程；`spine_import_json` 默认拒绝覆盖；`spine_export` 的 `clean:true` 会追加 `-m`，别对原件开启。
- 线协议改动前先看 README「和 DSH 对接时必须满足的两条线协议细节」：`_meta` 版本判定与 `ttlMs`/`cacheScope` 两条都踩过坑。

## 环境事实

- 源码 `D:/Spine-Mcp/src`，入口 `src/index.mjs`，协议层 `src/server.mjs`，工具实现在 `src/tools.mjs`。
- Spine CLI：`D:/Spine/Spine3.8.75Pro/Spine3.8.75Pro/Spine.com`（`SPINE_EXE`），GUI 同目录 `Spine.exe`。
- 零依赖，无构建步骤：`src` 下的 `.mjs` 就是运行时真相。
