# dsh-codex-computer-use

DSH 的独立 Codex Computer Use 插件，**0.1.0-experimental.6**。安装时自动准备官方 CU、签名 Node、完整 CU SDK/配套模块和 CLI；**不要求用户预先安装 Codex 或 ChatGPT 桌面应用**。独立 namespace：mcp__codex_cu__*，不替换 KimiCU。

## 用户怎么用

源码已开源于 https://github.com/dshapp/dsh-codex-computer-use ，采用 MIT（保留 KimiCU 原始归属）。通过 GitHub Actions 发布到公共 npm，并附带 Provenance；实验版推荐指定 experimental 标签：

~~~sh
dsh plugin --profile codex-cu-experiment add dsh-codex-computer-use@experimental
# 若本机 npm 默认 registry 是内部镜像，先为此命令显式指定公共 registry：
# npm_config_registry=https://registry.npmjs.org dsh plugin --profile codex-cu-experiment add dsh-codex-computer-use@experimental
# 历史 GitHub Release 的 .4 安装包仍可下载；目录/Git 包需要按 DSH 提示允许构建。
dsh --profile codex-cu-experiment
~~~

正常 npm 安装会运行 postinstall，自动准备运行环境。pnpm/DSH 禁止生命周期脚本或使用 --ignore-scripts 时，插件**首次启动会补装**，不需要用户另行找 Codex、@oai/sky 或 CLI。首次下载需要等待；进度与失败原因输出到安装终端/DSH 日志。

**支持条件：macOS Apple Silicon（arm64），CU 要求 macOS 14.4+。** Intel Mac、Windows、Linux 目前没有已验证的自动安装来源；安装钩子不为这些平台伪装可用。DSH/开发 Node >=22.19。

首次使用仍可能需要用户在 macOS 中授予官方 CU 的辅助功能、屏幕录制等系统权限。安装器不修改 TCC、不模拟用户同意；这和“不需要预装 Codex”是不同条件。也不要将当前电脑已有权限状态推广成所有新机都无需权限确认。

## 自动准备哪些东西

1. **先检测本地** /Applications 与 ~/Applications 的 Codex/ChatGPT 兼容 app：确认 Node、CLI、CU 来自同一已验证 cohort，验证版本、签名、标识和文件摘要。完整且有效时 **直接复用已有 Node/CLI/CU 路径，不复制 Node/CLI，不下载**。
   - CU 还需匹配 CODEX_HOME/computer-use 的 canonical 布局；本地已有匹配 CU 则直接用。若只缺这份 canonical CU，但已有 app 包含它，仅补齐 CU 到私有 home，不远程下载，不复制用户账号文件。
   - 本地缺失/不匹配时，先复用已经验证的管理缓存；连缓存也缺失才下载固定官方 ZIP。原 app 更新/删除/损坏会让本地引用失效，下一次重新检测，不继续执行旧 marker。
   - 当前兼容验证 cohort 为 26.1007.30912，不会仅因其他版本也“存在”就盲目混用。
2. 核验维护者固定的 SHA256、归档大小、解包路径/符号链接，验证根 app 的完整签名、版本和 OpenAI Team ID。
3. 只有需要管理下载时才保留完整 cua_node 与 codex-cli 目录，包括签名 Node、原生 NodeREPL、CU SDK、配套模块和 CodexCLI.app；本地直接复用时不拷贝这些目录，不靠公共 npm 安装本轮 registry 不可获得的 @oai 专用模块。
4. 在专属 CODEX_HOME/computer-use 中准备完整 Codex Computer Use.app；仅设置 SKY_CUA_SERVICE_PATH 而缺少 canonical app 不足以让官方 host 工作。
5. 临时目录验证完成后原子发布；缓存命中重新核验必要签名/摘要，失败可重试。进程内复用下载、跨进程安装锁，避免重复下载或半成品被当成 ready。

本地引用的验证标记与下载缓存位于用户 Library/Caches/dsh-codex-computer-use/runtime；缓存按版本分目录。不向 /Applications 安装整个 Codex/ChatGPT，不修改官方副本，不复制用户认证、账号、配置或会话文件。本地复用时官方 CLI 会使用所选已有 CODEX_HOME，插件不读取或复制其认证文件。专属 CODEX_HOME 不是原生 CU 全局 IPC 的完全隔离承诺。

第一次无本地兼容 app 时，需下载约 **686 MiB** 的官方归档；运行时约数百 MiB，解压/验证阶段需约 **6 GiB 可用空间**。临时完整桌面 app 验证后删除，只保留依赖目录和 CU app。已准备的兼容版本不会每次重下载，也不会自动追随 latest。

固定来源：[官方版本 ZIP](https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.1007.30912.zip)，版本 26.1007.30912；SHA256 是本轮从官方 HTTPS 下载、验证官方签名后维护者固定的摘要，**不是宣称 OpenAI 发布了此 SHA 清单**。见 [来源清单](./runtime-source.json)。选用与已验证 CU/CLI 匹配的版本，避免从多个 latest 来源拼出不兼容组合。

本包只分发安装器、bridge 和 skill。GitHub Release 可托管明确有开放许可的组件；CU、node_repl 和未找到自身再分发许可的 @oai 专用模块 **未公开镜像，继续从官方来源获取**。详见 [依赖分发策略](./docs/distribution.md)；官方下载、本机提取不代表供应商对第三方集成的授权或长期支持保证。保留官方版权、许可证和签名；本插件 MIT 许可不延伸到下载的专有组件。

## 诊断、离线包与重试

~~~sh
# 普通使用不需要先跑这些；遇到问题可以重试/复查。
dsh-codex-cu-setup
# 仅检查准备标记，不下载；不等价真实 GUI ready。
dsh-codex-cu-setup --check
# 重新验证/准备同一固定版本，发布前不影响旧缓存。
dsh-codex-cu-setup --force
# 用完全相同的官方 ZIP 离线准备；仍校验 pin 和签名。
dsh-codex-cu-setup --archive /absolute/path/official-pinned.zip --skip-local
# 真实只读诊断：自动准备 + initialize/listTools/list_apps，不点击/输入。
dsh-codex-cu-doctor
~~~

setup 的 --runtime-dir 可指定绝对缓存目录；--source-app 仅接受正确版本、签名的官方 app。环境 DSH_CODEX_CU_ARCHIVE 可提供精确 ZIP，DSH_CODEX_CU_SKIP_LOCAL=1 强制不依赖已安装 app。

CI/不希望安装时下载可设置 DSH_CODEX_CU_SKIP_SETUP=1；这仅跳过 npm hook，默认插件首次使用仍补装。若连首次使用也禁止下载，设置 autoSetup=false 并预先准备缓存或提供全部显式路径。

## 配置与访问策略

默认 config={} 即可：自动准备、独立运行时、permissionMode=allow-all。高级覆盖稳定 row id：

~~~yaml
- id: computer-use-codex-cu
  config:
    autoSetup: true
    runtimeDir: /absolute/path/private-runtime-cache
    permissionMode: allow-all
    toolCallTimeoutMs: 60000
~~~

默认自动接受已识别的官方“应用访问 + 空表单”请求，不弹逐应用确认，不需要名单。prompt 可恢复逐应用确认；deny 只允许 allowedApps 的精确显示名称。账号、token、URL flow、未知表单/请求和已取消的请求仍拒绝。

应用访问放开意味着 agent 可能读取/操作敏感应用；只在信任当前 agent/任务环境时使用。它不是发送消息、删除、购买或发布的业务授权，agent 仍须按风险确认；也不授予缺失的 macOS 权限。切回 prompt/deny 并重启可恢复限制；allow-all 下清空名单不能限制应用。

兼容专家手动模式：mode=direct 保留直连诊断；提供全部 appPath/nodePath/cliPath 会跳过自举。这些 override 必须绝对路径/可执行，但任意 override 不会被自动宣称为官方签名。显式 codexHome 优先；自定义 home 应自行满足其 computer-use canonical app 布局。

## 为什么不直接用普通 Node

普通 Node 直接启动官方 CU 会被 -10000 Sender process is not authenticated 拒绝。本包由 OpenAI 签名 Node 执行 MCP proxy，再启动官方 CU；同时显式提供官方 CLI/服务路径，解决随后可能出现的 -10005。proxy 实现 elicitation/create，避免 get_app_state 因缺应用授权回调返回 Method not found。

启动链：DSH → 通用 MCP bridge → **已验证的本地官方签名 Node（或缺失时准备的管理缓存 Node）** → MCP permission proxy → 官方 CU client/service。没有重新签名、修改官方 binaries、伪造 token 或关闭系统安全机制。

工具参数以 live MCP schema 为准：Codex 使用字符串 element_index、单数 key、direction/pages，不能照搬 KimiCU index/keys/pid/snapshot_id/clear/submit 等参数。见 [操作 skill](./skills/codex-computer-use/SKILL.md)。

## 开发验证与回退

~~~sh
DSH_CODEX_CU_SKIP_SETUP=1 npm install
npm run check
npm run test:pack
npm run setup
npm run doctor
~~~

[验证记录](./docs/validation.md)区分单测、生产安装钩子和真实只读验收；[调研记录](./docs/local-investigation.md)与[历史直连基线](./docs/direct-probe.json)保留问题定位过程。只读成功不等于全部点击/输入/拖拽或后台光标行为已认证。

停用/卸载本插件或切回 KimiCU profile 即可回退。安装器不终止共享 CU service，不自动删除正在使用的旧版 bundle。缓存可在确认没有相关客户端/服务使用它后手动清理，不删除任何原 Codex 安装或用户账号文件。

~~~sh
dsh plugin --profile codex-cu-experiment remove dsh-codex-computer-use
~~~

[LICENSE](./LICENSE)（仅本插件代码）。
