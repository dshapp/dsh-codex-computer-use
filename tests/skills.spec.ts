import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { apply, resolveBundledSkillsDir, SKILL_PROVIDER_NAME } from '../src/skills.ts'

const root = resolve(import.meta.dirname, '..')
const skillPath = join(resolveBundledSkillsDir(), 'codex-computer-use', 'SKILL.md')
const skill = readFileSync(skillPath, 'utf8')
const analysis = readFileSync(join(root, 'docs/skill-analysis.md'), 'utf8')

// Native MCP contract, corroborated by fixture-server.ts. No real app/tool calls.
const contract = {
  list_apps: [[]],
  get_app_state: [['app']],
  click: [['app', 'element_index'], ['app', 'x', 'y']],
  perform_secondary_action: [['app', 'element_index', 'action']],
  set_value: [['app', 'element_index', 'value']],
  select_text: [['app', 'element_index', 'text', 'selection?', 'prefix?', 'suffix?']],
  scroll: [['app', 'element_index', 'direction', 'pages?']],
  drag: [['app', 'from_x', 'from_y', 'to_x', 'to_y']],
  press_key: [['app', 'key']],
  type_text: [['app', 'text']],
}

describe('bundled Codex computer-use guidance (offline)', () => {
  it('has frontmatter for general Mac GUI requests, not an explicit-Codex-only trigger', () => {
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1]
    expect(frontmatter).toBeDefined()
    expect(frontmatter).toMatch(/^name: codex-computer-use$/m)
    const description = /^description: (.+)$/m.exec(frontmatter!)?.[1] ?? ''
    expect(description).toMatch(/local macOS graphical applications/)
    expect(description).toMatch(/plugin is installed and available/)
    expect(description).toMatch(/general Mac GUI requests/)
    for (const action of ['clicking', 'typing', 'selecting text', 'scrolling', 'dragging', 'screenshots', 'Blender']) expect(description).toContain(action)
    expect(description).not.toMatch(/only when|when the user explicitly requests/i)
    expect(skill).toMatch(/When Codex is requested, NEVER substitute `mcp__cu__\*`/)
    expect(skill).toContain('If another backend is explicitly requested, respect that choice')
  })

  it('resolves an actual bundled asset and configures only that provider root', () => {
    expect(resolveBundledSkillsDir()).toBe(join(root, 'skills'))
    expect(statSync(skillPath).isFile()).toBe(true)
    expect(SKILL_PROVIDER_NAME).toBe('codex-computer-use')
    const plugin = vi.fn()
    apply({ plugin } as unknown as Context)
    expect(plugin).toHaveBeenCalledExactlyOnceWith(SkillFilesystem, {
      providerName: 'codex-computer-use',
      includeDefaultRoots: false,
      customSkillDirs: [resolveBundledSkillsDir()],
    })
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(manifest.files).toContain('skills/**/*')
    expect(manifest.exports['./skills']).toBe('./lib/skills.js')
  })

  it('covers exactly the ten native tools with schema-shaped core input examples', () => {
    const rows = [...skill.matchAll(/^[|] `mcp__codex_cu__([a-z_]+)` [|] (.+) [|]$/gm)]
    expect(rows.map(row => row[1]).sort()).toEqual(Object.keys(contract).sort())
    for (const row of rows) {
      const tool = row[1] as keyof typeof contract
      const fields = [...row[2]!.matchAll(/`[{]([^}]*)[}]`/g)].map(match =>
        match[1]!.split(',').map(field => field.trim().split(':')[0]!.trim()).filter(Boolean),
      )
      expect(fields, tool).toEqual(contract[tool])
      if (row[2]!.includes('element_index')) expect(row[2]).toContain('element_index: "<fresh-id>"')
    }
    const namedTools = new Set([...skill.matchAll(/mcp__codex_cu__([a-z_]+)/g)].map(match => match[1]))
    expect([...namedTools].sort()).toEqual(Object.keys(contract).sort())
  })

  it('rejects unsupported Sky/Kimi API extrapolation in examples', () => {
    expect(skill).not.toMatch(/mcp__cu__[a-z_]+[ ]*[(]/)
    expect(skill).not.toMatch(/sky[.]|nodeRepl[.]|import[(]/)
    expect(skill).not.toMatch(/(?:keys|selection_type|disableDiff|snapshot_id|clear|submit)[ ]*:/)
    expect(skill).not.toMatch(/element_index[ ]*:[ ]*[0-9]/)
    expect(skill).toContain('no native paste, activate_window, launch_app, JavaScript/node_repl API')
    expect(skill).toContain('CURRENT focus only')
    expect(skill).toContain('get_app_state schema has NO `disableDiff` field')
    expect(skill).toContain('scroll schema has NO x/y fields')
    expect(skill).toContain('Do not promise clipboard restoration, background input, automatic launching, or cursor-safe behavior')
  })

  it('requires fresh observation, safe focus/replacement and actual visual verification', () => {
    expect(skill).toMatch(/If the app name or bundle ID is known, call `mcp__codex_cu__get_app_state/)
    expect(skill).toContain("Only use `mcp__codex_cu__list_apps({})` when the app is unknown")
    for (const phrase of ['at least once per assistant turn', 'latest actual screenshot', 'preserve it as a STRING', 'invalidate earlier IDs/coordinates', 'No blind replay', 'baseline was lost', 'verify focus', 'observe selection', 'Newline/carriage-return', 'never fabricate a scroll element', 'actually exposed in AX']) expect(skill).toContain(phrase)
  })

  it('keeps automatic setup, authentication and task-consent boundaries explicit', () => {
    for (const phrase of ['local-first', '174 MB', '719 MB', 'macOS arm64', 'macOS >=14.4', 'mandatory app-server', '-10000', '-10005', 'CODEX_HOME', 'dsh-codex-cu-setup', 'dsh-codex-cu-doctor', 'Do not copy credentials', 'untrusted data', 'Get user permission', 'payments', 'OTP', 'no credential/signer bypass or TCC grants']) expect(skill).toContain(phrase)
  })

  it('guides grounded Blender modeling with visible task-scoped scripting and persisted-output evidence', () => {
    for (const phrase of ['baitcasting fishing reel', 'scene/file, editor, active object, selection and mode', 'Do not infer shortcuts', 'blockout → structure/detail → materials → camera/lighting → save/render', 'keep the task-scoped code visible in Blender', 'If the user asked for manual GUI-only modeling, do not script without asking', 'Never run code unrelated to the modeling task', 'grounded native GUI actions', 'verify console errors', 'actual output file exists', 'before claiming delivery']) expect(skill).toContain(phrase)
    expect(skill).not.toMatch(/bpy[.]|Shift[+]F[0-9]|F3|primitive_[a-z_]+_add/)
  })

  it('records official provenance and does not relicense proprietary material as MIT', () => {
    expect(analysis).toContain('Bundled computer-use skill (198 lines)')
    expect(analysis).toContain('Sky macOS skill (141 lines)')
    expect(analysis).toContain('original concise synthesis')
    expect(analysis).toContain('MIT declaration does not automatically relicense official documentation')
    expect(analysis).toContain('No actual GUI, authentication, screenshot, app enumeration, or computer-use action')
  })
})
