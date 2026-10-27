# npm Actions 发布

发布 workflow 为 `.github/workflows/publish-npm.yml`。push main 自动校验，不自动提升版本；发布 GitHub Release 或在 Actions 手动 Run workflow（仅 main）才执行 npm 发布。实验版本进入 experimental，稳定版本进入 latest。

流程：公开 registry npm ci --ignore-scripts → arm64 macOS typecheck/build/tests/package smoke → 打包构建产物 → Ubuntu 独立发布 job校验payload name/version → npm publish --provenance --ignore-scripts。第三方/vendor binaries不进入 npm tarball。所有 action pinned SHA。

## 发布授权

当前已配置 npm Trusted Publisher（OIDC）：GitHub owner dshapp / repository dsh-codex-computer-use / workflow publish-npm.yml / environment npm。允许 npm publish 与 npm dist-tag，GitHub publish job具备 id-token:write。首次新配置需要真正发布一次验证；后续不需要长期 npm token。

首次新包若尚未建立可信发布配置，需要在本仓库 Actions Secret添加 NPM_TOKEN（允许发布本包的授权，不能写源码或日志）。workflow仅在publish步骤注入 NODE_AUTH_TOKEN，构建job无该Secret。首发后可登录 npm配置OIDC并删除Secret。本轮初次发布 .5 经用户确认使用临时加密 Secret；配置 OIDC 后删除，仅保留用户原有本机凭据不变。

已存在版本只验证，不覆盖、不自动patch。后续版本请更新package.json/package-lock，创建对应v版本Release或在main手动触发。
