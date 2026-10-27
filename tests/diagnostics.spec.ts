import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { resolve } from 'node:path'
import { classifyCall, classifyException, diagnose } from '../src/diagnostics.ts'

const fixture = resolve(import.meta.dirname, 'fixture-server.ts')
const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) {
    // Regression failures must not leave the package-owned fixture orphaned.
    try {
      const pid = Number(readFileSync(join(dir, 'fixture.pid'), 'utf8'))
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL')
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})
const run = (mode: string, timeoutMs = 5000) => diagnose({ command: process.execPath, args: [fixture, mode], timeoutMs })
async function probeAndVerifyExit(mode: string, timeoutMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-codex-cu-pid-'))
  dirs.push(dir)
  const pidFile = join(dir, 'fixture.pid')
  const report = await diagnose({ command: process.execPath, args: [fixture, mode, pidFile], timeoutMs })
  const pid = Number(readFileSync(pidFile, 'utf8'))
  await vi.waitFor(() => {
    let alive = false
    try { process.kill(pid, 0); alive = true } catch {}
    expect(alive).toBe(false)
  }, { timeout: 1500 })
  return report
}

describe('bounded read-only doctor', () => {
  it('distinguishes discovery from actual authorization', async () => {
    const report = await run('denied')
    expect(report.discovery).toBe(true)
    expect(report.toolNames).toHaveLength(10)
    expect(report.status).toBe('authentication-rejected')
    expect(report.readOnlyCall).toBe('failed')
    expect(report.appInteraction).toBe('not-tested')
  })
  it('does not declare desktop input ready after list_apps', async () => {
    const report = await run('success')
    expect(report.status).toBe('read-only-call-ok')
    expect(report.readOnlyCall).toBe('ok')
    expect(report.appInteraction).toBe('not-tested')
    expect(JSON.stringify(report)).not.toContain('Fixture App')
  })
  it('does not misclassify permission errors as process authentication', async () => {
    expect((await run('failed')).status).toBe('call-failed')
  })
  it('does not call other app tools when list_apps is unavailable', async () => {
    const report = await run('no-list')
    expect(report.discovery).toBe(true)
    expect(report.readOnlyCall).toBe('not-tested')
    expect(report.status).toBe('protocol-failed')
  })
  it('closes a hung tool call within a bounded interval', async () => {
    const started = Date.now()
    const report = await probeAndVerifyExit('hang', 1500)
    expect(['call-failed','protocol-failed']).toContain(report.status)
    expect(report.message).toContain('timed out')
    expect(Date.now() - started).toBeLessThan(6000)
  }, 8000)
  it('classifies thrown JSON-RPC sender authentication errors', async () => {
    expect((await run('rpc-denied')).status).toBe('authentication-rejected')
    expect(classifyException({ code: -10000, message: 'redacted' })?.status).toBe('authentication-rejected')
    expect(classifyException({ code: -10009, message: 'Permissions not granted' })).toBeUndefined()
  })
  it('releases a process that ignores stdin and SIGTERM', async () => {
    const report = await probeAndVerifyExit('hang-ignore-term', 1500)
    expect(report.message).toContain('timed out')
  }, 10000)
  it('releases a process whose handshake hangs', async () => {
    const report = await probeAndVerifyExit('handshake-hang', 1500)
    expect(report.discovery).toBe(false)
    expect(report.message).toContain('timed out')
  }, 10000)
  it('shares the generic bridge environment scrub policy', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-not-a-real-key')
    vi.stubEnv('DSH_SAMPLE_FACT', 'not-forwarded')
    vi.stubEnv('CODEX_HOME', '/tmp/codex-home')
    const env = scrubbedParentEnv()
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(env.DSH_SAMPLE_FACT).toBeUndefined()
    expect(env.CODEX_HOME).toBe('/tmp/codex-home')
  })
  it('validates helper timeout input independently of the CLI', async () => {
    await expect(run('success', 0)).rejects.toThrow('timeoutMs')
  })
  it('reports spawn/handshake failures without raw process content', async () => {
    const report = await diagnose({ command: '/nonexistent/codex-client', args: [], timeoutMs: 1000 })
    expect(report.status).toBe('protocol-failed')
    expect(report.discovery).toBe(false)
  })
  it('requires an actual MCP error to classify auth denial', () => {
    expect(classifyCall({ content: [{ type: 'text', text: 'Sender process is not authenticated' }] }).status).toBe('read-only-call-ok')
  })
})
