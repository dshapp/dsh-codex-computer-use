# 验证记录（2026-10-27）

## 0.1.0-experimental.4：直接复用本地 + GitHub 开源发布

- 6个测试文件113项通过，包含76项bootstrap（原37保留+39项local直接复用/失效/跨进程/策略）。构建/typecheck/production package main/skill/bin smoke均通过。
- 本机默认setup实际选择 provenance.kind=local：Node与CLI来自原 /Applications/ChatGPT.app/Contents/Resources，CU来自已有 ~/.codex/computer-use；日志 Directly reusing，未copy Node/CLI/CU、未download。
- 此直接路径下doctor真实list_apps成功，DSH registry有10个工具且调用isError=false；未输出应用列表/用户内容。
- 仅缺canonical CU时mock验证只补CU；完整本地三组件zero-copy/zero-download；缺失/损坏或版本不兼容回退已验证cache，无cache才官方download；skipLocal/force明确绕过本地。同步/跨进程marker检验已覆盖。
- GitHub独立CLI精确版本0.162.0-alpha.17.2 archive下载SHA匹配cc893d1787bedbf34001bf2d16378f479393b9e635f8dbc74e8abb7870fe3998，归档仅一个CLI executable，Apple anchor/Team2DC签名和--version验证通过。许可材料见 [分发策略](./distribution.md)。该公开独立CLI通过现有CU cohort的真实doctor list_apps验收。
- 不以Node/CLI开放许可覆盖CU、@oai或node_repl；这些尚未公开镜像。无需预装路径的生产下载测试仍是上一版记录，完整管理下载逻辑未替换成未经许可的GitHub CU archive。


## 0.1.0-experimental.3：无需预装 Codex 的自动运行环境

npm postinstall 自动准备官方来源；脚本被禁用时，DSH 插件首次启动 prepareLaunch 补齐。独立缓存中完整 cua_node/codex-cli + canonical CODEX_HOME CUapp；不复制用户认证/配置/会话。来源为固定官方ZIP，本机下载摘要和实际签名验证见 [调研](./local-investigation.md) 与 [来源pin](../runtime-source.json)。

- npm run check：类型检查和构建通过，6 个测试文件、74 个测试通过。
- 新增37个bootstrap单测，涵盖源/摘要/签名/布局、解包路径/符号链接、缓存、并发/崩溃锁、取消、平台/权限/容量、损坏修复和mock HTTP错误；4个安装/首次启动集成测试涵盖ignore-scripts补装、显式override/opt-out、私有缓存路径选择。
- 普通Node fetch对固定官方ZIP的真实HEAD：HTTP200，application/zip，719413559字节。
- 真实生产 postinstall：打包后 --omit=dev 普通安装（未用 --ignore-scripts），强制跳过已有 app，由默认 Node fetch 下载官方 ZIP；退出 0、自动准备成功，本次网络约 12 分钟。
- 缓存中的官方 Node/CLI/CU 路径全部位于私有 runtime，不使用 /Applications；默认 doctor 真实 list_apps、DSH bridge 真实 list_apps、仅复制 CU app 到空 CODEX_HOME 的 managed-only list_apps 均成功。
- 管理缓存路径下 Finder get_app_state：isError=false，5733 字符 AX 文本、624498 字节有效 JPEG；内容未输出到报告。
- 完整来源 app、Node、CLIapp、CUapp 严格签名验证通过；新增 Apple trust anchor + leaf OU Team 要求已在真实来源与 cache doctor 中通过。系统版本检查在下载前拒绝 macOS <14.4。
- 安装器只验证和准备依赖，不启动 GUI 授权、不给 TCC 系统授权、不执行 GUI 写操作。脚本禁用的包导入/setup bin/lifecycle skip smoke 同样通过。

此测试不能清除/隔离本机既有macOS权限或全局CU IPC服务，不能宣称完全未配置的新Mac没有首次权限步骤。源码/NPM包没有OpenAI专有二进制；仅本机从官方源提取完整相互匹配组件。


## 0.1.0-experimental.2：用户要求默认放开应用访问

新增 permissionMode=allow-all 并设为默认，仅自动接受已识别的官方应用访问请求；账号/URL/未知表单以及已取消请求仍拒绝。保留 prompt/deny 模式。没有为本轮策略测试读取 Mail/Safari 等实际应用数据，相关名称仅出现在 fixture/策略测试中。此前 Finder 的真实只读验收和未执行 GUI 写操作的边界保持不变。

本版本 npm run check 退出 0：类型检查、构建与 33 个测试全部通过；npm run test:pack 的隔离生产安装检查通过。新增覆盖无应用名单的 allow-all、其他已识别应用的自动批准、未知/账号/URL 表单仍拒绝、取消请求仍拒绝，以及真实 Cordis/relay fixture 授权流程。

## 0.1.0-experimental.1：鉴权与 Finder 只读验收

## 实际鉴权与只读调用

[机器可读记录](./local-probe.json)保存结果摘要，不含应用清单、AX 原文或截图内容。

| 测试 | 真实结果 |
|---|---|
| 普通 Node 直接启动 CU 的旧基线 | -10000，见 [旧报告](./direct-probe.json) |
| 仅换官方 signed Node | -10000 消失，出现 -10005 app-server exited |
| signed Node + 官方 CLI 路径/服务路径 | list_apps isError=false |
| 当前默认 node lib/doctor.js | 退出 0，read-only-call-ok，发现 10 个工具 |
| node scripts/verify-local.mjs | 真实 Cordis/DSH bridge 内 list_apps isError=false，10 tools，skill 注册成功 |
| node scripts/verify-window.mjs | 普通 Node SDK 经新 proxy 获取 Finder state：isError=false，5733 字符 AX 文本，624498 字节有效 JPEG |

Finder 权限经过本轮用户明确确认。未知应用默认需要本机确认对话框或明确 allowedApps 配置；没有自动允许所有应用。未执行 GUI 点击、输入、删除、发送或拖拽。

注意：doctor 自己仍只验收 list_apps，因此它的 appInteraction=not-tested 没有改成“全部GUI ready”。Finder 状态/截图是独立脚本验收，不能推广到所有应用、写操作或后台无光标保证。

## 自动化回归

- Node v26.8.2，Vitest 4.1.12。
- npm run check：类型检查、tsdown 构建通过，4 个测试文件、29 个测试通过。
- 覆盖：DSH bundle/skill 注册、参数透传、MCP error 保留、signed launch 环境、elicitation app allowlist/拒绝/未知表单/URL、SDK 并发 close、初始化挂起、EOF、重复 SIGTERM、子进程忽略 TERM 后回收。
- Lifecycle 测试仅使用包内 fixture；PID 退出断言和失败清理只针对本测试创建的进程，没有 pkill 共享 codex/node/CU service。
- npm run test:pack：退出 0；npm pack 产物在干净临时目录以 --omit=dev --ignore-scripts 安装，main/skills/patch/doctor --help 通过；临时安装已清理。

## 边界与回退

官方 binaries/签名、账号凭据和系统级安全机制未修改；无需恢复原件。原 KimiCU 工作树保持干净，当前用户 profile/Web GUI 未改动。停用/卸载新插件或切回原 KimiCU profile 即可回退；mode=direct 可复现旧链路。删掉 allowedApps 项并重启可撤销本插件预配置及内存授权缓存；官方应用自己的权限行为由它管理。

本包只管理自己创建的 MCP proxy/客户端，不终止共享 CU service。不承诺对官方 service 自己启动的所有后代进程拥有清理权或完成全部场景的生命周期认证。

依赖审计：当前 lockfile 的 npm audit 返回 0 vulnerabilities；官方更新或 registry 变更后需重新核验。
