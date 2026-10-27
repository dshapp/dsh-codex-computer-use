import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { assertClientExecutable, resolveAppPath, resolveClientPath } from './paths.ts'
import { ensureRuntime, readPreparedRuntime } from './bootstrap.ts'

export interface LaunchOptions {
  appPath?: string
  codexHome?: string
  nodePath?: string
  cliPath?: string
  mode?: 'signed-node' | 'direct'
  allowedApps?: string[]
  permissionMode?: 'allow-all' | 'prompt' | 'deny'
  toolCallTimeoutMs?: number
  runtimeDir?: string
  autoSetup?: boolean
}
export interface LaunchSpec {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

function officialExecutable(relativePath: string, override: string | undefined, label: string): string {
  const candidates = ['/Applications/ChatGPT.app', '/Applications/Codex.app'].map(app => join(app, 'Contents/Resources', relativePath))
  const path = override || candidates.find(candidate => existsSync(candidate))
  if (!path || !isAbsolute(path)) throw new Error('Run dsh-codex-cu-setup to prepare the official runtime, or set an absolute ' + label + '.')
  assertClientExecutable(path)
  return path
}

export function resolveLauncherPath(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('../package.json')), 'lib', 'launcher.js')
}

/** Installation hooks can be disabled by npm/pnpm; recover on first plugin use. */
export async function prepareLaunch(options: LaunchOptions = {}, log?: (message: string) => void, signal?: AbortSignal): Promise<void> {
  if (options.mode === 'direct' || options.autoSetup === false || (options.appPath && options.nodePath && options.cliPath)) return
  await ensureRuntime({ runtimeDir: options.runtimeDir, log, signal })
}

/** Prepared private runtime takes precedence over incidental desktop installations. */
export function resolveLaunchSpec(options: LaunchOptions = {}): LaunchSpec {
  const prepared = readPreparedRuntime(options.runtimeDir)
  const codexHome = options.codexHome || prepared?.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex')
  if (!isAbsolute(codexHome)) throw new Error('CODEX_HOME/codexHome must be absolute.')
  const paths = { appPath: options.appPath || (options.codexHome ? undefined : prepared?.appPath), codexHome }
  const client = resolveClientPath(paths)
  const appPath = resolveAppPath(paths)
  assertClientExecutable(client)
  if (options.mode === 'direct') return { command: client, args: ['mcp'], cwd: appPath, env: {} }
  const node = officialExecutable('cua_node/bin/node', options.nodePath || prepared?.nodePath, 'nodePath')
  const cli = officialExecutable('codex-cli/CodexCLI.app/Contents/MacOS/codex', options.cliPath || prepared?.cliPath || process.env.CODEX_CLI_PATH, 'cliPath')
  const launcher = resolveLauncherPath()
  if (!existsSync(launcher)) throw new Error('Build the Codex CU plugin first (npm run build): ' + launcher)
  return {
    command: node,
    args: [launcher, client],
    cwd: appPath,
    env: { CODEX_HOME: codexHome, CODEX_CLI_PATH: cli, SKY_CUA_SERVICE_PATH: appPath, NODE_OPTIONS: '', NODE_PATH: '', DSH_CODEX_CU_ALLOWED_APPS: JSON.stringify(options.allowedApps || []), DSH_CODEX_CU_PERMISSION_MODE: options.permissionMode || 'allow-all', DSH_CODEX_CU_TOOL_TIMEOUT_MS: String(options.toolCallTimeoutMs ?? 60000) },
  }
}
