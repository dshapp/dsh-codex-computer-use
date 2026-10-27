/** Thin, experimental DSH adapter. No token forwarding or authentication bypass. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { SERVER_NAME } from './paths.ts'
import { prepareLaunch, resolveLaunchSpec, type LaunchOptions } from './launch-config.ts'

export const name = 'codex-computer-use'
export const inject = ['tools']

export interface Config extends LaunchOptions {
  appPath: string
  toolCallTimeoutMs: number
}

export const Config: z<Config> = z.object({
  appPath: z.string().default(''),
  runtimeDir: z.string().default(''),
  autoSetup: z.boolean().default(true),
  codexHome: z.string().default(''),
  nodePath: z.string().default(''),
  cliPath: z.string().default(''),
  mode: z.union([z.const('signed-node'), z.const('direct')]).default('signed-node'),
  allowedApps: z.array(String).default([]),
  permissionMode: z.union([z.const('allow-all'), z.const('prompt'), z.const('deny')]).default('allow-all'),
  toolCallTimeoutMs: z.number().step(1).min(1).max(600_000).default(60_000),
})

export function createMcpConfig(config: Config): McpClient.StdioConfig {
  const launch = resolveLaunchSpec(config)
  return {
    serverName: SERVER_NAME,
    transport: 'stdio',
    ...launch,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    failOnStartupError: true,
    // No speculative retries for authorization failures or actions.
    reconnect: { enabled: false },
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const abort = new AbortController()
  ctx.effect(() => () => abort.abort())
  await prepareLaunch(config, message => ctx.logger.info(message), abort.signal)
  if (abort.signal.aborted) return
  const mcpConfig = createMcpConfig(config)
  ctx.logger.info('Codex CU: ' + (config.mode === 'direct' ? 'direct diagnostic mode (may reject sender authentication)' : 'official signed-Node launch chain') + '; discovery alone does not verify app permissions. Run dsh-codex-cu-doctor.')
  ctx.plugin(McpClient, mcpConfig)
}
