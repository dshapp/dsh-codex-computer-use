import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as CodexCu from '../src/index.ts'
import * as CodexCuSkills from '../src/skills.ts'
import { CLIENT_RELATIVE_PATH, resolveAppPath, resolveClientPath } from '../src/paths.ts'

const root = resolve(import.meta.dirname, '..')
const patchFile = join(root, 'cordis.patch.yml')
const fixture = resolve(import.meta.dirname, 'fixture-server.ts')
const contexts: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Row { id: string; name: string; config?: Record<string, unknown> }
function rows(patches: PatchOptions[]): Row[] {
  return patches[0]!.insert as Row[]
}

function fixtureApp(mode: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-codex-cu-test-'))
  dirs.push(dir)
  const appPath = join(dir, 'Codex Computer Use.app')
  const command = join(appPath, CLIENT_RELATIVE_PATH)
  mkdirSync(dirname(command), { recursive: true })
  symlinkSync(process.execPath, command)
  writeFileSync(join(appPath, 'package.json'), JSON.stringify({ type: 'module' }))
  // The adapter's real args=['mcp'] are preserved; only the executable is a fixture.
  writeFileSync(join(appPath, 'mcp'), 'process.argv[2] = ' + JSON.stringify(mode) + '; await import(' + JSON.stringify(pathToFileURL(fixture).href) + ');')
  return appPath
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for MCP tools')
    await new Promise(r => setTimeout(r, 25))
  }
}

async function load(mode: string, launchMode: 'direct' | 'signed-node' = 'direct', permissionMode: 'allow-all' | 'prompt' | 'deny' = 'deny'): Promise<Context> {
  const patches = loadOverlayPatches('codex-cu-test', patchFile)
  const [adapter, skill] = rows(patches)
  adapter!.name = 'cordis:codex-cu-test-adapter'
  skill!.name = 'cordis:codex-cu-test-skill-provider'
  const override: PatchOptions = { id: 'computer-use-codex-cu', config: { appPath: fixtureApp(mode), toolCallTimeoutMs: 5000, mode: launchMode, nodePath: process.execPath, cliPath: process.execPath, allowedApps: permissionMode === 'allow-all' ? [] : ['Finder'], permissionMode } }
  const ctx = await boot('codex-cu-test', join(import.meta.dirname, 'fixtures/base.cordis.yml'), [...patches, override], ctx => {
    ctx.loader.builtins['codex-cu-test-system-prompt'] = SystemPrompt
    ctx.loader.builtins['codex-cu-test-tools'] = ToolRegistry
    ctx.loader.builtins['codex-cu-test-skills'] = SkillRegistry
    ctx.loader.builtins['codex-cu-test-adapter'] = CodexCu
    ctx.loader.builtins['codex-cu-test-skill-provider'] = CodexCuSkills
  })
  contexts.push(ctx)
  await waitFor(() => ctx.tools.schemas().filter(s => s.name.startsWith('mcp__codex_cu__')).length === 10)
  return ctx
}

describe('Codex CU package and path resolution', () => {
  it('uses portable per-user defaults and explicit overrides without shell expansion', () => {
    expect(resolveAppPath({ home: '/Users/example' })).toBe('/Users/example/.codex/computer-use/Codex Computer Use.app')
    expect(resolveAppPath({ codexHome: '/tmp/alternate' })).toBe('/tmp/alternate/computer-use/Codex Computer Use.app')
    expect(resolveClientPath({ appPath: '/tmp/custom app' })).toBe(join('/tmp/custom app', CLIENT_RELATIVE_PATH))
    expect(() => resolveAppPath({ appPath: '~/Codex Computer Use.app' })).toThrow('absolute path')
    expect(() => resolveAppPath({ codexHome: 'relative' })).toThrow('absolute path')
  })
  it('keeps an independent namespace and does not forward credentials', () => {
    const config = CodexCu.createMcpConfig({ appPath: fixtureApp('success'), toolCallTimeoutMs: 1234, mode: 'direct' })
    expect(config.serverName).toBe('codex_cu')
    expect(config.args).toEqual(['mcp'])
    expect(config.env).toEqual({})
    expect(config.reconnect?.enabled).toBe(false)
    expect(config.toolCallTimeoutMs).toBe(1234)
  })
  it('uses signed Node as the direct parent and supplies the official CLI context', () => {
    const appPath = fixtureApp('success')
    const config = CodexCu.createMcpConfig({ appPath, toolCallTimeoutMs: 1234, nodePath: process.execPath, cliPath: process.execPath, allowedApps: ['Finder'], permissionMode: 'deny' })
    expect(config.command).toBe(process.execPath)
    expect(config.args[0]).toBe(join(root, 'lib', 'launcher.js'))
    expect(config.args[1]).toBe(join(appPath, CLIENT_RELATIVE_PATH))
    expect(config.env.CODEX_CLI_PATH).toBe(process.execPath)
    expect(config.env.SKY_CUA_SERVICE_PATH).toBe(appPath)
    expect(config.env.NODE_OPTIONS).toBe('')
    expect(config.env.DSH_CODEX_CU_TOOL_TIMEOUT_MS).toBe('1234')
    expect(config.env).not.toHaveProperty('DEEPSEEK_API_KEY')
  })
  it('defaults the proxy environment to allow-all without an app whitelist', () => {
    const config = CodexCu.createMcpConfig({ appPath: fixtureApp('success'), toolCallTimeoutMs: 1234, nodePath: process.execPath, cliPath: process.execPath })
    expect(config.env.DSH_CODEX_CU_PERMISSION_MODE).toBe('allow-all')
    expect(config.env.DSH_CODEX_CU_ALLOWED_APPS).toBe('[]')
  })
  it('fails clearly when the official app is missing', () => {
    expect(() => CodexCu.createMcpConfig({ appPath: '/nonexistent/Codex.app', toolCallTimeoutMs: 1000 })).toThrow('missing or not executable')
  })
  it('declares adapter and skill rows through a DSH bundle patch', () => {
    const [adapter, skill] = rows(loadOverlayPatches('codex-cu-test', patchFile))
    expect(adapter!.id).toBe('computer-use-codex-cu')
    expect(adapter!.name).toBe('dsh-codex-computer-use')
    expect(skill!.name).toBe('dsh-codex-computer-use/skills')
  })
})

describe('real Cordis loader / DSH MCP bridge (fixture only)', () => {
  it('registers Codex schemas + skill and preserves string element IDs and singular key', async () => {
    const ctx = await load('success')
    expect(ctx.tools.schemas().some(s => s.name.startsWith('mcp__cu__'))).toBe(false)
    expect((await ctx.skills.list()).some(s => s.name === 'codex-computer-use')).toBe(true)
    const args = { app: 'Fixture App', element_index: 'node-42', value: 'test' }
    const result = await ctx.tools.execute({ callId: 'codex-cu-fixture-value' as CallId, name: 'mcp__codex_cu__set_value', arguments: args, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result)).toContain('node-42')
    const key = await ctx.tools.execute({ callId: 'codex-cu-fixture-key' as CallId, name: 'mcp__codex_cu__press_key', arguments: { app: 'Fixture App', key: 'Return' }, signal: new AbortController().signal })
    expect(key.isError).toBe(false)
    expect(JSON.stringify(key)).toContain('Return')
    const registry = ctx.tools
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    expect(registry.schemas().some(s => s.name.startsWith('mcp__codex_cu__'))).toBe(false)
  }, 15_000)
  it('relays real MCP framing and calls through the signed-Node launch path (fixture Node only)', async () => {
    const ctx = await load('success', 'signed-node')
    const result = await ctx.tools.execute({ callId: 'relay-fixture-call' as CallId, name: 'mcp__codex_cu__list_apps', arguments: {}, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result)).toContain('Fixture App')
  }, 15000)
  it('handles vendor elicitation inside the relay without unsupported upstream requests', async () => {
    const ctx = await load('permission', 'signed-node')
    const result = await ctx.tools.execute({ callId: 'relay-permission-call' as CallId, name: 'mcp__codex_cu__get_app_state', arguments: { app: 'Finder' }, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result)).toContain('accept')
  }, 15000)
  it('allow-all resolves the official app permission request with no per-app list (fixture)', async () => {
    const ctx = await load('permission', 'signed-node', 'allow-all')
    const result = await ctx.tools.execute({ callId: 'relay-allow-all-call' as CallId, name: 'mcp__codex_cu__get_app_state', arguments: { app: 'Finder' }, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result)).toContain('accept')
  }, 15000)
  it('preserves vendor authorization errors instead of reporting success', async () => {
    const ctx = await load('denied')
    const result = await ctx.tools.execute({ callId: 'codex-cu-denied' as CallId, name: 'mcp__codex_cu__list_apps', arguments: {}, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Sender process is not authenticated')
  }, 15_000)
})
