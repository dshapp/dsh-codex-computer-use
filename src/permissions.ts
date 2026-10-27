import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js'

export interface PermissionOptions { allowedApps: string[]; permissionMode: 'allow-all' | 'prompt' | 'deny' }
export function permissionApp(params: ElicitRequest['params']): string | undefined {
  if ('mode' in params && params.mode !== 'form') return
  if (!('requestedSchema' in params) || params.requestedSchema.type !== 'object') return
  const schema = params.requestedSchema
  if (Object.keys(schema.properties).length || (schema.required?.length ?? 0)) return
  const prefix = 'Allow ChatGPT to use '
  if (!params.message.startsWith(prefix) || !params.message.endsWith('?')) return
  const app = params.message.slice(prefix.length, -1)
  if (!app.trim() || app.length > 200 || app.includes('\n') || app.includes('\r')) return
  return app
}

export async function promptForApp(app: string, signal: AbortSignal): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  const script = 'on run argv\nset answer to display dialog (item 1 of argv) with title "DSH Codex Computer Use" buttons {"拒绝", "允许"} default button "拒绝" giving up after 30\nreturn button returned of answer\nend run'
  try {
    const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-e', script, 'Codex CU 请求访问应用：' + app + '。\n允许后可读取窗口并操作该应用；本次连接结束后不保留本插件的批准缓存。'], { signal, timeout: 35000, maxBuffer: 8192 })
    return stdout.trim() === '允许'
  } catch { return false }
}

/** Only the observed empty-schema, app-specific permission request is supported.
 * allow-all applies only to app access, never account/token forms or URL flows. No disk persistence. */
export function createPermissionHandler(options: PermissionOptions, prompt = promptForApp) {
  const accepted = new Set(options.allowedApps)
  return async (request: ElicitRequest, signal: AbortSignal): Promise<ElicitResult> => {
    const app = permissionApp(request.params)
    if (!app || signal.aborted) return { action: 'decline' }
    if (options.permissionMode === 'allow-all') return { action: 'accept', content: {} }
    if (!accepted.has(app)) {
      if (options.permissionMode === 'deny' || !await prompt(app, signal) || signal.aborted) return { action: 'decline' }
      accepted.add(app)
    }
    return { action: 'accept', content: {} }
  }
}
