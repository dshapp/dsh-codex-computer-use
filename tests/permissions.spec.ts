import { describe, it, expect, vi } from 'vitest'
import type { ElicitRequest } from '@modelcontextprotocol/sdk/types.js'
import { permissionApp, createPermissionHandler } from '../src/permissions.ts'
const request = (app = 'Finder'): ElicitRequest => ({ method: 'elicitation/create', params: { message: 'Allow ChatGPT to use ' + app + '?', requestedSchema: { type: 'object', properties: {} } } })
const signal = () => new AbortController().signal

describe('explicit app permission policy', () => {
  it('recognizes only the exact empty-schema vendor app request', () => {
    expect(permissionApp(request().params)).toBe('Finder')
    expect(permissionApp(request('Finder\nSomething').params)).toBeUndefined()
    const other = request(); other.params.message = 'Enter your account token'
    expect(permissionApp(other.params)).toBeUndefined()
  })
  it('accepts an explicitly configured app without blanket approval', async () => {
    const prompt = vi.fn(async () => true)
    const handle = createPermissionHandler({ allowedApps: ['Finder'], permissionMode: 'deny' }, prompt)
    expect(await handle(request(), signal())).toEqual({ action: 'accept', content: {} })
    expect(await handle(request('Mail'), signal())).toEqual({ action: 'decline' })
    expect(prompt).not.toHaveBeenCalled()
  })
  it('allow-all accepts recognized apps without a whitelist or a prompt', async () => {
    const prompt = vi.fn(async () => false)
    const handle = createPermissionHandler({ allowedApps: [], permissionMode: 'allow-all' }, prompt)
    for (const app of ['Finder', 'Mail', 'Safari', 'Notes']) {
      expect(await handle(request(app), signal())).toEqual({ action: 'accept', content: {} })
    }
    expect(prompt).not.toHaveBeenCalled()
  })
  it('allow-all still declines unknown forms, URLs and cancelled requests', async () => {
    const handle = createPermissionHandler({ allowedApps: [], permissionMode: 'allow-all' })
    const form = request('Mail')
    if ('requestedSchema' in form.params) form.params.requestedSchema.properties = { password: { type: 'string' } }
    expect((await handle(form, signal())).action).toBe('decline')
    const url: ElicitRequest = { method: 'elicitation/create', params: { mode: 'url', elicitationId: 'fixture', url: 'https://example.invalid', message: 'Allow ChatGPT to use Mail?' } }
    expect((await handle(url, signal())).action).toBe('decline')
    const unknown = request('Mail'); unknown.params.message = 'Approve a purchase?'
    expect((await handle(unknown, signal())).action).toBe('decline')
    const abort = new AbortController(); abort.abort()
    expect((await handle(request('Mail'), abort.signal)).action).toBe('decline')
  })
  it('asks before accepting another app and caches only within this handler', async () => {
    const prompt = vi.fn(async () => true)
    const handle = createPermissionHandler({ allowedApps: [], permissionMode: 'prompt' }, prompt)
    expect((await handle(request(), signal())).action).toBe('accept')
    expect((await handle(request(), signal())).action).toBe('accept')
    expect(prompt).toHaveBeenCalledTimes(1)
  })
  it('honors decline and cancellation', async () => {
    const handle = createPermissionHandler({ allowedApps: [], permissionMode: 'prompt' }, async () => false)
    expect((await handle(request(), signal())).action).toBe('decline')
    const abort = new AbortController(); abort.abort()
    expect((await createPermissionHandler({ allowedApps: ['Finder'], permissionMode: 'deny' })(request(), abort.signal)).action).toBe('decline')
  })
  it('never accepts account forms or URL elicitation', async () => {
    const prompt = vi.fn(async () => true)
    const handle = createPermissionHandler({ allowedApps: ['Finder'], permissionMode: 'prompt' }, prompt)
    const form = request()
    if ('requestedSchema' in form.params) form.params.requestedSchema.properties = { secret: { type: 'string' } }
    expect((await handle(form, signal())).action).toBe('decline')
    const url: ElicitRequest = { method: 'elicitation/create', params: { mode: 'url', elicitationId: 'fixture', url: 'https://example.invalid', message: 'Allow ChatGPT to use Finder?' } }
    expect((await handle(url, signal())).action).toBe('decline')
    expect(prompt).not.toHaveBeenCalled()
  })
})
