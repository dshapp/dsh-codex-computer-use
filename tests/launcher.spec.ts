import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { CLIENT_RELATIVE_PATH } from '../src/paths.ts'
const root = resolve(import.meta.dirname, '..')
const dirs: string[] = []
const pids: number[] = []
afterEach(() => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch {} }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
class Owned extends StdioClientTransport { closing?: Promise<void>; override close() { return this.closing ??= super.close() } }
function setup(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-codex-cu-relay-test-')); dirs.push(dir)
  const appPath = join(dir, 'Fixture CU.app')
  const command = join(appPath, CLIENT_RELATIVE_PATH)
  mkdirSync(dirname(command), { recursive: true }); symlinkSync(process.execPath, command)
  const pidFile = join(dir, 'child.pid')
  writeFileSync(join(appPath, 'package.json'), JSON.stringify({ type: 'module' }))
  const fixture = resolve(import.meta.dirname, 'fixture-server.ts')
  writeFileSync(join(appPath, 'mcp'), 'process.argv[2]=' + JSON.stringify(mode) + ';process.argv[3]=' + JSON.stringify(pidFile) + ';await import(' + JSON.stringify(pathToFileURL(fixture).href) + ');')
  const transport = new Owned({ command: process.execPath, args: [join(root, 'lib/launcher.js'), command], cwd: appPath, env: { DSH_CODEX_CU_PERMISSION_MODE: 'deny', DSH_CODEX_CU_ALLOWED_APPS: '[]' }, stderr: 'pipe' })
  transport.stderr!.on('data', () => {})
  return { transport, client: new Client({ name: 'fixture-relay-test', version: '1.0.0' }), pidFile }
}
async function assertGone(pid: number) {
  await vi.waitFor(() => { let alive = false; try { process.kill(pid, 0); alive = true } catch {}; expect(alive).toBe(false) }, { timeout: 2000 })
}
describe('owned signed relay lifecycle (fixture binary only)', () => {
  it('reaps an owned child that ignores TERM on upstream EOF', async () => {
    const { client, transport, pidFile } = setup('hang-ignore-term')
    try {
      await client.connect(transport, { timeout: 5000 })
      const pid = Number(readFileSync(pidFile, 'utf8')); pids.push(pid)
      await client.close(); await transport.close(); await assertGone(pid)
    } finally { try { await client.close() } finally { await transport.close() } }
  }, 8000)
  it('survives repeated TERM until the ignored-signal child has been reaped', async () => {
    const { client, transport, pidFile } = setup('hang-ignore-term')
    try {
      await client.connect(transport, { timeout: 5000 })
      const pid = Number(readFileSync(pidFile, 'utf8')); pids.push(pid)
      const wrapper = transport.pid!; pids.push(wrapper)
      process.kill(wrapper, 'SIGTERM')
      await new Promise(resolve => setTimeout(resolve, 100))
      process.kill(wrapper, 'SIGTERM')
      await assertGone(pid)
      await assertGone(wrapper)
    } finally { try { await client.close() } finally { await transport.close() } }
  }, 8000)
  it('reaps a nested child when inner initialize never completes', async () => {
    const { client, transport, pidFile } = setup('handshake-hang')
    try {
      await expect(client.connect(transport, { timeout: 1200 })).rejects.toThrow()
      const pid = Number(readFileSync(pidFile, 'utf8')); pids.push(pid)
      await client.close(); await transport.close(); await assertGone(pid)
    } finally { try { await client.close() } finally { await transport.close() } }
  }, 8000)
})
