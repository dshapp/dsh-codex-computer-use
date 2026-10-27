# GitHub 依赖分发策略

GitHub 源码和插件安装包采用本插件 MIT，保留原 KimiCU contributors 归属；该许可不覆盖第三方软件。

## 分层，不能将“签名”“private:false”“公开下载”当作统一授权

| 组件 | 来源/许可依据 | 发布策略 |
| --- | --- | --- |
| 插件源码、MCP proxy、skill | 本项目 MIT | 本仓库和 Release 插件 .tgz |
| 官方签名 Node 本体 | 所选运行时随附 Node LICENSE，MIT + 完整第三方通知 | Release 仅 Node executable + 原版完整 LICENSE + ORIGIN，不含 full cua_node |
| 官方独立 Codex CLI | [精确 tag](https://github.com/openai/codex/tree/rust-v0.162.0-alpha.17.2) workspace/CLI Apache-2.0；[LICENSE](https://raw.githubusercontent.com/openai/codex/rust-v0.162.0-alpha.17.2/LICENSE)、[NOTICE](https://raw.githubusercontent.com/openai/codex/rust-v0.162.0-alpha.17.2/NOTICE) | 本仓库 Release 镜像原版 archive（SHA 与上游一致）并同时提供完整 Apache2 LICENSE、NOTICE、Ratatui MIT LICENSE；保留上游来源与未作完整第三方静态依赖审计说明 |
| full bundled CodexCLI.app/codex-cli | 另含 helper、voice、zsh/rg、打包/profile，不能简单全部等同独立 Apache CLI | 未作为 whole-directory GitHub 镜像 |
| full cua_node/@oai modules/node_repl/CU app | 未找到给这些组件自身的公开再分发许可；不能用嵌套第三方 LICENSE 覆盖整体 | 不上传公开 GitHub；缺失时官方源本机提取，或用户提供本地合法副本；收到明确许可后再评估镜像 |

Node 镜像保留原签名，未修改/re-sign binary，签名不意味着本插件获 OpenAI 背书。Node LICENSE 明确许可 Node 本体，不扩展到 @oai、CU、node_repl。原全目录含 LGPL 等第三方库，不是单一 MIT。

CLI 对应版本为 0.162.0-alpha.17.2。其 [官方 GitHub archive](https://github.com/openai/codex/releases/download/rust-v0.162.0-alpha.17.2/codex-aarch64-apple-darwin.tar.gz) SHA256=cc893d1787bedbf34001bf2d16378f479393b9e635f8dbc74e8abb7870fe3998。公开 tag 的 workspace 与 CLI manifest/release workflow确认版本和 Apache2来源，NOTICE另涉及 [Ratatui 0.30.2 MIT](https://raw.githubusercontent.com/ratatui/ratatui/ratatui-v0.30.2/LICENSE)。这些是已核实材料，不等于对所有 Rust 静态依赖的完整法律审计；所有发布物已有通知必须保留，不能只贴一段 Apache/MIT 文本代替全部第三方要求。

## 自动下载边界

默认先检测并直接复用兼容本地组合，再复用管理缓存；都缺失才下载。当前完整 CU 运行时仍来自 [固定官方 ZIP](https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.1007.30912.zip)，因为 CU 等没有已核实公开镜像授权。GitHub component manifest 和合法 Node/CLI 发布物 **不伪装成对整个 CU 的再分发授权**，也不让安装器从用户提供的任意 latest 拼出未验证组合。

所以目前不能承诺“所有依赖只从本 GitHub 下载”。若需要做到这一点，需提供 OpenAI/相关权利人明确涵盖 CU、helpers、@oai modules/node_repl 的第三方公开再分发许可，并完成捆绑第三方库的条件（例如对应 LGPL 源码、归属、替换/调试权利）。
