# 本机 Codex CU 调研（2026-10-27）

## Standalone bootstrap 研究与实际来源

公开 @oai/sky/@oai/cua-repl npm 地址本轮为404，CU alpha更新feed为403，因此不把这些私有模块当作用户可自行安装的公共npm依赖。官方桌面更新源提供包含完整相互匹配运行时的归档，本包从 [固定官方ZIP](https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.1007.30912.zip) 本机提取 cua_node/codex-cli/CU app。

本轮实际下载719413559字节，维护者pin SHA256=b699a8c2d5a2f23cac59dc67388e25af4bf5fc2fb6ab30ffa243a968e4f815a3；检查5073个ZIP entries、25个symlinks；根app deep/strict签名和版本验证成功；Node、CLIapp、CUapp的Team均2DC432GLL2且strict签名有效。没有执行下载app的桌面shell或修改/重新签名其组件。

干净CODEX_HOME但没有其canonical CU app时，真实list_apps报runtime app missing；仅复制官方CUapp到该home/computer-use后，list_apps成功，未复制认证、账号或会话文件。该测试没有清除本机既有macOS权限或全局CU IPC状态，不代表完全未配置的新Mac无需系统权限同意。


## 后续实测修正：已打通，不需要改二进制

此前“普通 Node 直连被拒绝”仍成立，但不等于所有第三方本机启动链都不可用。后续实际验证：

1. 直接调用 → -10000 Sender process is not authenticated。
2. 用 ChatGPT 随包、TeamIdentifier=2DC432GLL2 的官方 Node 执行调用 → -10000 消失，进入 -10005 app-server exited。
3. 显式设置 CODEX_CLI_PATH 为随包 CodexCLI，加上 CODEX_HOME/SKY_CUA_SERVICE_PATH → list_apps isError=false。
4. get_app_state 需要官方 elicitation/create 回调；通用 bridge 缺失回调会产生 -32601 Method not found。
5. 补齐明确的应用授权处理后，在用户确认 Finder 权限的范围内，真实 AX 文本和 JPEG 截图均成功。普通 Node →本包签名 proxy →官方客户端的路径也通过，DSH bridge 内真实 list_apps 通过。

详见 [最终验证](./validation.md) 和 [本机报告](./local-probe.json)。没有修改、重签官方 binaries；没有伪造账号token。该路径是本机实测互操作，不是供应商长期支持承诺。下面保留最初的只读证据和当时未知项，不能再把它们当作“无法实现”的结论。


## 可确认的事实

- 安装位置：用户 .codex/computer-use 下的 Codex Computer Use.app；Info.plist 版本 26.1005.1001425，bundle ID com.openai.sky.CUAService，最低 macOS 14.4。
- 内置 SkyComputerUseClient 支持 mcp 参数：initialize 成功，server name 为 Computer Use；发现 10 个工具（见 README）。
- 本机实际 list_apps 和 get_app_state(Finder) 均返回 MCP isError=true：Computer Use server error -10000: Sender process is not authenticated（先前探测）。本包 doctor 再验证 list_apps，未继续截图/输入操作。
- KimiCU 包只是 generic MCP bridge + bundled skill；可以复用其 DSH 接入模式，但不能因此获得 OpenAI 进程信任。

## 官方 runtime 证据

以下是本机原始资源，未修改。它们随官方更新可能移动或改变。

1. [官方 MCP 配置](</Users/user/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1007.30912/.mcp.json#L4-L42>)：ChatGPT 随包 node 启动 @oai/cua-repl，再以 CUA_REPL_NODE_REPL_PATH 启动官方 node_repl；工具是 js、js_reset、turn_ended；配置 trusted Sky service、CODEX_HOME、官方 CU app 和 CodexCLI 路径。
2. [cua-repl 说明](</Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/README.md#L3-L15>)：由 Codex Desktop 选择、配置 runtime；[host 说明](</Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/README.md#L51-L55>)：Desktop 提供 trusted services，沿用已有 approval/permission，turn_ended 做 host cleanup。
3. [Sky native pipe 实现](</Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js#L1>)：依赖 nodeRepl.nativePipe.createConnection，默认使用 OpenAI Group Container 中 computeruse.sock，可请求 host ensureService。文件为压缩的一行实现。
4. [父进程签名要求资源](</Users/user/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/Resources/SkyComputerUseClient_Parent.coderequirement#L5-L6>)：team-identifier = 2DC432GLL2。资源的存在证明有父进程 team requirement，但不证明完整鉴权算法或唯一受信任 executable。
5. [官方错误分类](</Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/errors.js#L1>)：senderProcessNotAuthenticated=-10000，permissionsNotGranted=-10009，noActiveSession=-10011，permissionsPending=-10014 等是独立错误。

## 推测与未验证项

普通 Node 调用者/父进程不符合官方进程信任边界，是当前失败的合理解释；不能仅凭这些资源推出完整审计 token/祖先进程/session 校验算法。

官方配置中的 NODE_REPL_TRUSTED_CODE_PATHS 是 NodeREPL 信任配置，不是 macOS 签名身份替代；x-codex-turn-metadata 是上下文，未发现它是能消除 -10000 的 token。没有证据证明只换官方 node、抄 env 或复制 MCP 配置就会通过鉴权。

本轮没有读取 auth.json/会话数据，没有启动官方 cua_repl 来冒充 Desktop host，没有修改或重签官方二进制，没有绕过鉴权。未发现 DSH/第三方注册官方进程信任的受支持契约；这仅限本机已检查的资源，不是断言所有将来版本都永远不支持第三方。
