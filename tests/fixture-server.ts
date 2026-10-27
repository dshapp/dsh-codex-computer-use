import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { writeFileSync } from 'node:fs'
import { McpError, CallToolRequestSchema, ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js'

const mode = process.argv[2] ?? 'success'
if (process.argv[3]) writeFileSync(process.argv[3], String(process.pid))
if (mode === 'handshake-hang') {
  setInterval(() => {}, 1000)
  process.stdin.resume()
  await new Promise(() => {})
}
if (mode === 'hang-ignore-term') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}
const server = new McpServer({ name: 'codex-cu-fixture', version: '1.0.0' })
const app = z.string()
const element_index = z.string()
if (mode !== 'no-list') server.registerTool('list_apps', { inputSchema: {} }, async () => {
  if (mode === 'hang' || mode === 'hang-ignore-term') await new Promise(() => {})
  if (mode === 'denied') return { isError: true, content: [{ type: 'text', text: 'Computer Use server error -10000: Sender process is not authenticated' }] }
  if (mode === 'failed') return { isError: true, content: [{ type: 'text', text: 'Computer Use server error -10009: Permissions not granted' }] }
  return { content: [{ type: 'text', text: 'Fixture App (not a real desktop result)' }] }
})
const schemas = {
  get_app_state: { app },
  click: { app, element_index: element_index.optional(), x: z.number().optional(), y: z.number().optional(), click_count: z.number().int().optional(), mouse_button: z.enum(['left','right','middle']).optional() },
  perform_secondary_action: { app, element_index, action: z.string() },
  set_value: { app, element_index, value: z.string() },
  select_text: { app, element_index, text: z.string(), selection: z.enum(['text','cursor_before','cursor_after']).optional(), prefix: z.string().optional(), suffix: z.string().optional() },
  scroll: { app, element_index, direction: z.string(), pages: z.number().optional() },
  drag: { app, from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number() },
  press_key: { app, key: z.string() },
  type_text: { app, text: z.string() },
}
for (const [name, inputSchema] of Object.entries(schemas)) {
  server.registerTool(name, { inputSchema }, async (args: Record<string, unknown>) => {
    if (name === 'get_app_state' && mode === 'permission') {
      const permission = await server.server.request({ method: 'elicitation/create', params: { message: 'Allow ChatGPT to use Finder?', requestedSchema: { type: 'object', properties: {} } } }, ElicitResultSchema)
      return { isError: permission.action !== 'accept', content: [{ type: 'text' as const, text: JSON.stringify({ fixture: true, permission: permission.action }) }] }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ fixture: true, tool: name, args }) }] }
  })
}
if (mode === 'rpc-denied') server.server.setRequestHandler(CallToolRequestSchema, async () => {
  throw new McpError(-10000, 'Sender process is not authenticated')
})
await server.connect(new StdioServerTransport())
