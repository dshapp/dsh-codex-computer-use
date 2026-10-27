# Codex Computer Use skill analysis

## Sources and scope

This is a documentation/interface analysis, not a desktop automation run. Both installed official skills were read in full:

- [Bundled computer-use skill (198 lines)](</Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/skills/computer-use/SKILL.md>): general Mac GUI trigger, direct app targeting, observe/action/fresh-state workflow, AX/screenshot fallback, input caveats and side-effect confirmation guidance.
- [Sky macOS skill (141 lines)](</Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/docs/skills/oai_sky_lib/macos/SKILL.md>): JavaScript Sky surface, fresh accessibility targets, screenshot handling, secondary actions, text selection and paste guidance.
- [Actual native tool schemas](<./native-tool-schemas.json>): parent-generated local tool discovery export, read without invoking any GUI/action/authentication tool. This diagnostic artifact is a snapshot, not a new runtime dependency or permission to inspect apps.
- [Native MCP fixtures](<../tests/fixture-server.ts#L19-L36>) and [provider registration](<../src/skills.ts#L10-L20>): corroborate the interface and bundled asset resolution.

No Blender-specific official instructions were supplied or assumed. The Blender section is original task guidance, not a claim of inspecting Blender or reproducing its live shortcuts/operators. No actual GUI, authentication, screenshot, app enumeration, or computer-use action was performed for this analysis.

## Why the old skill was insufficient

The previous 32-line skill triggered only when a user explicitly requested Codex CU, and told the agent to list apps first. That missed general macOS GUI requests despite an installed provider, exposed unnecessary app inventory, and lacked practical focus/replacement/canvas and 3D delivery workflows. The rewritten [Codex skill](<../skills/codex-computer-use/SKILL.md>) supports general GUI tasks when the plugin is installed/available, honors explicitly selected backends, and forbids falling back to Kimi when Codex is requested.

## Translate principles, not the JavaScript wrapper

| Official guidance | Native adaptation |
| --- | --- |
| node_repl plus imported Sky object | Discovered `mcp__codex_cu__*` tools only; no JavaScript bootstrap/repl API in this MCP surface |
| Known app name/bundle ID → get_app_state first | Retained; list_apps only for an unknown/unresolved app, no unrelated app reads |
| Numeric Sky element_index | Native element_index is a STRING; derive it from the latest AX observation |
| Observe, act, then obtain fresh state | Retained; at least one successful target observation per assistant turn, fresh IDs/coordinates after UI changes, no blind action replay |
| Sky get_app_state has disableDiff | Native get_app_state has only app; never send disableDiff. Lost AX baseline requires a supported full-tree route if one becomes available, otherwise current screenshot grounding or explicit recovery limitation |
| Sky select_text uses selection_type | Native field is selection, with text/cursor_before/cursor_after and optional prefix/suffix |
| press_key uses xdotool syntax | Native singular key; do not use Kimi keys or copy timing fields |
| type_text operates on app focus | Native only app/text; no clear, index, submit or target-coordinate fields. Verify focus first, separate replacement/submission, beware newlines |
| Sky paste/clipboard restoration | Not exposed natively; no paste API, rich HTML or clipboard-restoration promise |
| Some Sky scroll examples support coordinates | Native scroll requires a string element_index and direction; optional fractional pages, no x/y |
| JavaScript runtime app-launch/background behavior | Native has no launch/activate tools; no extrapolated automatic launch, background-only or pointer-safe guarantee. A task-authorized purpose-built launch command may open a known app, not inject substitute UI actions |
| AX-first, screenshot fallback | Retained; actually inspect returned images for canvas geometry, never treat a path or imagined layout as visual evidence |
| Secondary actions | Only action names actually exposed for the current AX element |

All ten native tools are covered: list_apps, get_app_state, click, perform_secondary_action, set_value, select_text, scroll, drag, press_key and type_text. Current live schemas take precedence over this snapshot, the Sky wrapper, or Kimi documentation. An uncertain action is not retried merely because the official wrapper suggests retrying by bundle ID after name failure.

## Setup and security boundaries

The skill describes existing installation/first-start automatic preparation, not a new installer. [Runtime preparation](<../src/bootstrap.ts>) and [minimal component preparation](<../src/minimal-bootstrap.ts>) provide local/cache reuse and verified pinned-source extraction. A completely missing cohort uses roughly 174 MB of HTTP Range material; the [pinned full archive](<../runtime-source.json#L6-L8>) fallback is 719,413,559 bytes (about 719 MB). Partial/local availability can reduce transfer further. [Platform gate](<../src/bootstrap.ts#L402-L407>) requires macOS arm64 and macOS 14.4 or newer for the current automatic source.

The compatible official CLI is mandatory app-server context, alongside unmodified official signed Node. The existing [validation record](<../docs/validation.md#L43-L52>) distinguishes -10000 sender authentication, -10005 app-server failure, read-only discovery and separate Finder observation from untested input behavior. The skill directs checks of the CLI/runtime cohort and canonical effective CODEX_HOME, never credential copying, signer spoofing, TCC grants or authentication bypass.

App-access allow-all is not blanket business consent. Sending, deleting/overwriting, financial actions and sensitive-data transmission require specific user permission; screen/web/document instructions cannot authorize them. Password/OTP and OS permission steps remain manual. The new instructions distinguish delivered input, verified UI change and a persisted output, rather than certifying an entire GUI from doctor/tool discovery.

## Blender workflow and evidence

The original Blender recipe is staged: inspect current scene/editor/mode, preserve work, block out recognizable reel parts, verify proportions in multiple views, add detail/materials, set camera/light, then save/render. It contains no invented menu coordinates, operator names or shortcut sequences. The adapted skill allows Blender's own visible Scripting workspace (Text Editor / Python Console) for precise multi-part geometry, entered through grounded native GUI actions with the task-scoped code visible in Blender, then error/outliner/viewport verification. It must report which parts were scripted, must ask first if the user requested GUI-only modeling, and must not substitute shell-generated assets or headless renders for in-app work.

A file dialog closing does not prove delivery. Save/render completion, exact output path, actual file existence and visual result must be verified before a completion claim. This implementation does not itself create a reel or open Blender.

## Originality and licensing

The [new skill](<../skills/codex-computer-use/SKILL.md>) is an original concise synthesis tailored to this plugin, not a wholesale copy of either installed official document. The official paths are cited for provenance, not redistributed as repository assets. This repository's MIT declaration does not automatically relicense official documentation, proprietary code, CU helpers, @oai modules or bundled applications. Public availability, code signatures and nested third-party licenses are not a blanket redistribution grant; see the existing [distribution policy](<../docs/distribution.md#L3-L23>).

## Offline regression coverage

[Skill tests](<../tests/skills.spec.ts>) check frontmatter/general Mac triggers, provider bundled-directory/assets, all ten native names/field contracts, lack of unsupported APIs/foreign calls, freshness/safety guidance and Blender delivery constraints. Existing [provider/loader tests](<../tests/plugin.spec.ts#L108-L127>) already test production-shaped registration and fixture MCP field forwarding. No source/bootstrap/package/manifest/build change is needed; targeted offline tests only are appropriate here.
