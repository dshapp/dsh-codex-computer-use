#!/usr/bin/env node
/** Run by the official signed Node. Relay vendor tools/results and handle only
 * explicit app permissions; no signature patches or credential forwarding. */
import { isAbsolute } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ElicitRequestSchema, ListToolsRequestSchema, ListToolsResultSchema, CallToolRequestSchema, CallToolResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { assertClientExecutable } from './paths.ts'
import { createPermissionHandler } from './permissions.ts'

/** Coalesce the SDK's unawaited initialize-failure close and bound owned-child shutdown. */
class OwnedTransport extends StdioClientTransport {
  private closing?: Promise<void>
  private childClosed = false
  constructor(options: ConstructorParameters<typeof StdioClientTransport>[0]) {
    super(options)
    this.onclose = () => { this.childClosed = true }
  }
  override close(): Promise<void> {
    if (this.closing) return this.closing
    const pid = this.pid
    const kill = (signal: NodeJS.Signals) => {
      if (pid && !this.childClosed) { try { process.kill(pid, signal) } catch {} }
    }
    const term = setTimeout(() => kill('SIGTERM'), 800)
    const hard = setTimeout(() => kill('SIGKILL'), 1500)
    this.closing = super.close().finally(() => { clearTimeout(term); clearTimeout(hard) })
    return this.closing
  }
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (!command || !isAbsolute(command) || process.argv.length !== 3) throw new Error('Usage: signed-node launcher.js ABSOLUTE_SKY_CLIENT_PATH')
  assertClientExecutable(command)
  const allowedApps: unknown = JSON.parse(process.env.DSH_CODEX_CU_ALLOWED_APPS || '[]')
  if (!Array.isArray(allowedApps) || allowedApps.some(app => typeof app !== 'string' || !app.trim() || app.length > 200)) throw new Error('Invalid allowedApps configuration')
  const permissionMode = process.env.DSH_CODEX_CU_PERMISSION_MODE || 'allow-all'
  if (permissionMode !== 'allow-all' && permissionMode !== 'prompt' && permissionMode !== 'deny') throw new Error('Invalid permissionMode')
  const toolCallTimeoutMs = Number(process.env.DSH_CODEX_CU_TOOL_TIMEOUT_MS || 60000)
  if (!Number.isSafeInteger(toolCallTimeoutMs) || toolCallTimeoutMs < 1 || toolCallTimeoutMs > 600000) throw new Error('Invalid toolCallTimeoutMs')
  const handlePermission = createPermissionHandler({ allowedApps, permissionMode })
  const env = scrubbedParentEnv()
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_HOST_SERVICES_PIPE_PATH', 'SKY_CUA_SERVICE_NATIVE_PIPE_PATH']) delete env[key]
  const transport = new OwnedTransport({ command, args: ['mcp'], env, stderr: 'inherit' })
  const client = new Client({ name: 'dsh-codex-cu-signed-relay', version: '0.1.0' }, { capabilities: { elicitation: { form: {} } } })
  const stopping = new AbortController()
  client.setRequestHandler(ElicitRequestSchema, (request, extra) => handlePermission(request, AbortSignal.any([extra.signal, stopping.signal])))
  let server: Server | undefined
  let closing: Promise<void> | undefined
  const shutdown = () => closing ??= Promise.resolve().then(async () => {
    stopping.abort()
    try { if (server) await server.close() }
    finally { try { await client.close() } finally { await transport.close() } }
    process.stdin.destroy()
  })
  const stop = () => { void shutdown().catch(() => { process.exitCode = 1 }) }
  client.onclose = stop
  const interrupt = () => { process.exitCode = 130; stop() }
  const terminate = () => { process.exitCode = 143; stop() }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  process.stdin.once('end', stop)
  process.stdin.once('error', stop)
  process.stdout.once('error', () => { process.exitCode = 1; stop() })
  try {
    await client.connect(transport, { signal: AbortSignal.any([AbortSignal.timeout(15000), stopping.signal]), timeout: 15000 })
    if (stopping.signal.aborted) return
    const info = client.getServerVersion()!
    const listChanged = client.getServerCapabilities()?.tools?.listChanged ?? false
    server = new Server(info, { capabilities: { tools: { listChanged } }, instructions: client.getInstructions() })
    server.setRequestHandler(ListToolsRequestSchema, (request, extra) => client.request({ method: 'tools/list', params: request.params }, ListToolsResultSchema, { signal: AbortSignal.any([extra.signal, stopping.signal]), timeout: 15000 }))
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => client.request({ method: 'tools/call', params: request.params }, CallToolResultSchema, { signal: AbortSignal.any([extra.signal, stopping.signal]), timeout: toolCallTimeoutMs }))
    if (listChanged) client.setNotificationHandler(ToolListChangedNotificationSchema, () => server!.notification({ method: 'notifications/tools/list_changed' }))
    server.onclose = stop
    await server.connect(new StdioServerTransport())
  } catch (error) {
    process.exitCode = 1
    console.error(error instanceof Error ? 'Codex CU relay failed: ' + error.message : 'Codex CU relay failed.')
    await shutdown()
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Codex CU launcher failed.'); process.exitCode = 1 })
