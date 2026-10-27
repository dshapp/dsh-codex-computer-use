import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** SDK Client.connect initiates close without awaiting it on handshake failure.
 * Coalesce concurrent close calls so our finally awaits that same teardown. */
class OwnedStdioTransport extends StdioClientTransport {
  private closing?: Promise<void>
  override close(): Promise<void> {
    return this.closing ??= super.close()
  }
}

export type ProbeStatus = 'read-only-call-ok' | 'authentication-rejected' | 'call-failed' | 'protocol-failed'
export interface DiagnosticReport {
  status: ProbeStatus
  discovery: boolean
  toolNames: string[]
  server?: { name: string; version: string }
  readOnlyCall: 'not-tested' | 'ok' | 'failed'
  appInteraction: 'not-tested'
  message: string
}

/** Never infer readiness from initialize/listTools, nor dump app data into logs. */
export function classifyCall(result: CallToolResult): Pick<DiagnosticReport, 'status' | 'message'> {
  if (!result.isError) return {
    status: 'read-only-call-ok',
    message: 'list_apps succeeded. Desktop state, screenshots and input have NOT been tested.',
  }
  const text = result.content.filter(p => p.type === 'text').map(p => p.text).join(' ')
  if (text.toLowerCase().includes('sender process is not authenticated')) return {
    status: 'authentication-rejected',
    message: 'Vendor rejected the sender process (-10000). MCP discovery is not authorization. This plugin cannot grant OpenAI process trust; no authentication bypass is attempted. Accessibility permissions are a separate check.',
  }
  return {
    status: 'call-failed',
    message: 'list_apps returned an MCP tool error. Inspect the official Codex Computer Use application; raw tool contents are intentionally omitted.',
  }
}

export interface ProbeOptions {
  command: string
  args: string[]
  cwd?: string
  timeoutMs: number
  env?: Record<string, string>
}

export function classifyException(error: unknown): Pick<DiagnosticReport, 'status' | 'message'> | undefined {
  if (typeof error !== 'object' || error === null) return
  const record = error as { code?: unknown; message?: unknown }
  if (record.code === -10000 || (typeof record.message === 'string' && record.message.toLowerCase().includes('sender process is not authenticated'))) {
    return classifyCall({ isError: true, content: [{ type: 'text', text: 'Sender process is not authenticated' }] })
  }
}

/** Request budget is bounded; SDK teardown can add up to roughly four seconds. */
export async function diagnose(options: ProbeOptions): Promise<DiagnosticReport> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000) throw new Error('timeoutMs must be an integer between 1 and 600000.')
  const report: DiagnosticReport = {
    status: 'protocol-failed', discovery: false, toolNames: [],
    readOnlyCall: 'not-tested', appInteraction: 'not-tested',
    message: 'MCP initialization or tool discovery failed.',
  }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), options.timeoutMs)
  const transport = new OwnedStdioTransport({
    command: options.command, args: options.args, cwd: options.cwd, stderr: 'pipe',
    // Match the DSH generic bridge's scrubbed ambient environment (no extra overrides).
    env: { ...scrubbedParentEnv(), ...options.env },
  })
  transport.stderr?.on('data', () => {})
  const client = new Client({ name: 'dsh-codex-cu-doctor', version: '0.1.0' })
  const requestOptions = { signal: abort.signal, timeout: options.timeoutMs }
  try {
    await client.connect(transport, requestOptions)
    report.server = client.getServerVersion()
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, requestOptions)
      report.toolNames.push(...page.tools.map(t => t.name))
      cursor = page.nextCursor
      if (cursor) {
        if (seen.has(cursor) || seen.size >= 100) throw new Error('Invalid tool pagination')
        seen.add(cursor)
      }
    } while (cursor)
    report.discovery = true
    if (!report.toolNames.includes('list_apps')) {
      report.message = 'MCP discovery succeeded, but list_apps is unavailable. No app operation was attempted.'
      return report
    }
    report.readOnlyCall = 'failed'
    report.status = 'call-failed'
    report.message = 'list_apps failed or timed out. No app input was attempted.'
    const result = await client.callTool({ name: 'list_apps', arguments: {} }, undefined, requestOptions)
    const classification = classifyCall(CallToolResultSchema.parse(result))
    Object.assign(report, classification)
    if (classification.status === 'read-only-call-ok') report.readOnlyCall = 'ok'
    return report
  } catch (error) {
    const classification = classifyException(error)
    if (classification) Object.assign(report, classification)
    if (abort.signal.aborted) report.message = 'Codex CU probe timed out. No app input was attempted.'
    return report
  } finally {
    clearTimeout(timer)
    // Even when Client.connect starts an unawaited close, await our coalesced
    // owned transport close to keep the process alive until teardown settles.
    try { await client.close() } finally { await transport.close() }
  }
}
