---
name: codex-computer-use
description: Use the Codex Computer Use backend when the user explicitly requests Codex CU for macOS application inspection or interaction. This plugin uses the official signed runtime and a user-configurable application access policy.
---

# Codex Computer Use

Use the discovered mcp__codex_cu__* tools; never silently substitute mcp__cu__* (KimiCU). This plugin's default signed-node route has passed real list_apps and user-approved Finder state/screenshot tests, not a full GUI input certification.

## Before operating an app

1. First call list_apps. Packaged installation prepares the official runtime automatically; if lifecycle scripts were blocked, first plugin startup repairs it. Missing tools during first download: check progress in DSH logs; if preparation failed, run dsh-codex-cu-setup to retry, then dsh-codex-cu-doctor. Do not tell users to install Codex or private @oai packages manually. The verified automatic source currently supports macOS arm64 only. macOS accessibility/screen-capture approval remains user-controlled. Never claim a prepared cache is proof all GUI permissions/input work.
2. On -10000, check mode is signed-node and nodePath is the unmodified official OpenAI-signed Node. On -10005, check cliPath points to the official CodexCLI binary. Do not read/copy tokens, fake session identity, patch signatures, or silently retry GUI actions.
3. Obtain a successful fresh get_app_state({ app }) for the target, at least once per assistant turn before any action. Tool discovery and list_apps alone do not establish app access or input readiness.
4. Official app access requests are handled by the signed proxy. This local user explicitly requested allow-all as the default: recognized app-access requests are accepted without a dialog or per-app whitelist. prompt/deny modes remain available. This policy does not grant missing macOS permissions; do not try to bypass them. Unknown/account/URL elicitation is declined. Only access apps/data relevant to the user's task; broad app access is not a request to inspect all apps.
5. An app-access grant is not permission to send/delete/purchase/publish; get separate business confirmation unless the user already explicitly authorized that action.

## Observe, act, verify

Read fresh screenshot and AX tree, ground one focused action, then read fresh state to verify. Preserve element_index as a STRING. Coordinates are screenshot pixels. Do not reuse either after UI changes. Do not assume background-only or pointer-safe behavior; those have not been verified for Codex CU.

Use live Codex schemas, not KimiCU's:

- click({ app, element_index }) or click({ app, x, y }); optional click_count/mouse_button.
- set_value({ app, element_index, value }); perform_secondary_action({ app, element_index, action }) only for actions actually shown.
- select_text({ app, element_index, text, selection?, prefix?, suffix? }) with exact visible text.
- scroll({ app, element_index, direction, pages? }); fractional pages supported.
- press_key({ app, key }); xdotool syntax, e.g. Return / super+c. Singular key, not keys.
- type_text({ app, text }) targets CURRENT focus. There is no clear/index/submit option.
- drag({ app, from_x, from_y, to_x, to_y }) uses fresh screenshot coordinates.

If an action's effect is uncertain, re-observe before deciding whether to retry; never replay blindly. All observed tools except list_apps require app. Prefer purpose-built APIs/CLIs where appropriate and avoid unrelated sensitive screenshot content.
