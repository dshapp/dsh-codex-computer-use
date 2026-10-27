import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBootstrapForTesting, inspectRuntimeZip, resolveRuntimeRoot } from '../src/bootstrap.ts'
import type { RuntimeSource } from '../src/bootstrap.ts'
const directories: string[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const d of directories.splice(0)) rmSync(d, { force: true, recursive: true }) })
function temp() { const d = realpathSync(mkdtempSync(join(tmpdir(), 'codex-bootstrap-test-'))); directories.push(d); return d }
function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
const bytes = Buffer.from('small fake official archive; never executed')
const source: RuntimeSource = { id: 'fixture-darwin-arm64', appVersion: '26.1007.30912', platform: 'darwin', arch: 'arm64', url: 'https://persistent.oaistatic.com/codex-app-prod/fixture.zip', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, teamIdentifier: '2DC432GLL2', layoutVersion: 1 }
const APP = 'Codex Computer Use.app'
async function put(path: string, value = 'fixture') { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, value, { mode: 0o755 }) }
async function fixture(app: string) {
  await put(join(app, 'Contents/Info.plist'), source.appVersion)
  await put(join(app, 'Contents/MacOS/ChatGPT'), 'fixture-source-executable')
  const resources = join(app, 'Contents/Resources')
  for (const path of ['cua_node/bin/node', 'cua_node/bin/node_repl', 'cua_node/lib/node_modules/@oai/sky/package.json', 'codex-cli/CodexCLI.app/Contents/MacOS/codex', 'cua_node/lib/node_modules/@oai/sky/' + APP + '/Contents/MacOS/SkyComputerUseService', 'cua_node/lib/node_modules/@oai/sky/' + APP + '/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient']) await put(join(resources, path))
}
function setup(extra: Parameters<typeof createBootstrapForTesting>[1] = {}) {
  const runtimeDir = join(temp(), 'runtime')
  const download = vi.fn(async (_s: RuntimeSource, file: string) => { await fs.writeFile(file, bytes) })
  const verifySigned = vi.fn(async () => {})
  const unpack = vi.fn(async (_archive: string, dest: string) => { await fixture(join(dest, 'ChatGPT.app')) })
  const deps = { localCandidates: () => [], localHomes: () => [], platform: 'darwin', arch: 'arm64', download, verifySigned, appVersion: async () => source.appVersion, inspectZip: async () => 1024, availableBytes: async () => 1024 ** 3, copy: async (s: string, d: string) => { await fs.cp(s, d, { recursive: true, verbatimSymlinks: true }) }, unpack, lockWaitMs: 1000, lockPollMs: 5, ...extra }
  const api = createBootstrapForTesting(source, deps)
  return { ...api, runtimeDir, download, verifySigned, unpack, deps }
}
describe('official runtime bootstrap (mock download, signatures, app and native commands)', () => {
  it('publishes complete canonical layout and hashes without user home data', async () => {
    const s = setup(), p = await s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })
    expect(p.root).toBe(s.runtimeDir); expect(p.appPath).toContain('/home/computer-use/' + APP)
    expect(await fs.readFile(p.nodePath, 'utf8')).toBe('fixture'); expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p)
    expect(await fs.readdir(p.codexHome)).toEqual(['computer-use']); expect(s.verifySigned).toHaveBeenCalledTimes(4)
    expect((await fs.stat(s.runtimeDir)).mode & 0o777).toBe(0o700)
    expect((await fs.readdir(s.runtimeDir)).sort()).toEqual(['versions'])
  })
  it('cache hit rechecks signatures and hashes without download', async () => {
    const s = setup(); await s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true }); await s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })
    expect(s.download).toHaveBeenCalledTimes(1); expect(s.verifySigned).toHaveBeenCalledTimes(7)
  })
  it('same-process concurrent preparation shares exactly one download', async () => {
    const s = setup(); const results = await Promise.all(Array.from({ length: 4 }, () => s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })))
    expect(s.download).toHaveBeenCalledTimes(1); expect(results.every(p => p.releaseDir === results[0]!.releaseDir)).toBe(true)
  })
  it('independent instances coordinate via directory lock and recheck ready', async () => {
    const s = setup(), second = createBootstrapForTesting(source, s.deps)
    await Promise.all([s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true }), second.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })]); expect(s.download).toHaveBeenCalledTimes(1)
  })
  it('rejects a mismatched pinned hash before unpack/signature or publish', async () => {
    const s = setup({ download: async (_s, file) => { await fs.writeFile(file, Buffer.alloc(bytes.length)) } })
    await expect(s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })).rejects.toThrow('SHA256')
    expect(s.unpack).not.toHaveBeenCalled(); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined(); expect(await fs.readdir(s.runtimeDir)).toEqual([])
  })
  it('checks local ZIP hash, does not download', async () => {
    const s = setup(), archivePath = join(temp(), 'local.zip'); await fs.writeFile(archivePath, bytes)
    await s.ensureRuntime({ runtimeDir: s.runtimeDir, archivePath, skipLocal: true }); expect(s.download).not.toHaveBeenCalled()
  })
  it('verifies explicit matching source app and avoids download', async () => {
    const s = setup(), sourceApp = join(temp(), 'ChatGPT.app'); await fixture(sourceApp)
    await s.ensureRuntime({ runtimeDir: s.runtimeDir, sourceApp }); expect(s.download).not.toHaveBeenCalled()
  })
  it('fails explicit source with wrong signing team', async () => {
    const s = setup({ verifySigned: async () => { throw Error('OpenAI signing team mismatch') } }), sourceApp = join(temp(), 'ChatGPT.app'); await fixture(sourceApp)
    await expect(s.ensureRuntime({ runtimeDir: s.runtimeDir, sourceApp })).rejects.toThrow('team mismatch'); expect(s.download).not.toHaveBeenCalled()
  })
  it('fails missing runtime layout without publishing', async () => {
    const s = setup({ unpack: async (_a, d) => { await fs.mkdir(join(d, 'ChatGPT.app'), { recursive: true }) } })
    await expect(s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })).rejects.toThrow('setup failed'); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined()
  })
  it('rejects escaping extracted symlinks before source code verification', async () => {
    const outside = temp(), s = setup({ unpack: async (_a, d) => { await fixture(join(d, 'ChatGPT.app')); await fs.symlink(outside, join(d, 'escape')) } })
    await expect(s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })).rejects.toThrow('escaping symlink'); expect(s.verifySigned).not.toHaveBeenCalled()
  })
  it('does not follow root or version directory symlinks', async () => {
    const s = setup(), outside = temp(); await fs.symlink(outside, s.runtimeDir)
    await expect(s.ensureRuntime({ runtimeDir: s.runtimeDir })).rejects.toThrow('symlink')
  })
  it('repairs corrupt cache but preserves old ready until replacement succeeds', async () => {
    const s = setup(), p = await s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true }); await fs.writeFile(p.nodePath, 'corrupt')
    const failing = createBootstrapForTesting(source, { ...s.deps, download: async () => { throw Error('offline') } })
    await expect(failing.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })).rejects.toThrow('offline'); expect(await fs.readFile(p.nodePath, 'utf8')).toBe('corrupt'); expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p)
    await s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true }); expect(await fs.readFile(p.nodePath, 'utf8')).toBe('fixture'); expect(s.download).toHaveBeenCalledTimes(2)
  })
  it('abort cleans partial/staging and releases lock', async () => {
    const controller = new AbortController(), s = setup({ download: async (_s, f) => { await fs.writeFile(f, bytes); controller.abort(Error('cancelled')); controller.signal.throwIfAborted() } })
    await expect(s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true, signal: controller.signal })).rejects.toThrow('cancelled'); expect(await fs.readdir(s.runtimeDir)).toEqual([])
  })
  it('reclaims a dead owner lock without killing any process', async () => {
    const s = setup(); await fs.mkdir(join(s.runtimeDir, '.install-lock'), { recursive: true }); await fs.writeFile(join(s.runtimeDir, '.install-lock/owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead', startTime: 1 }))
    await s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true }); expect(await fs.readdir(s.runtimeDir)).toEqual(['versions'])
  })
  it('times out a live-owner lock rather than killing its owner', async () => {
    const s = setup({ lockWaitMs: 10 }); await fs.mkdir(join(s.runtimeDir, '.install-lock'), { recursive: true }); await fs.writeFile(join(s.runtimeDir, '.install-lock/owner.json'), JSON.stringify({ pid: process.pid, token: 'live', startTime: 1 }))
    await expect(s.ensureRuntime({ runtimeDir: s.runtimeDir })).rejects.toThrow('Timed out'); expect(s.download).not.toHaveBeenCalled()
  })
  it('rejects unsupported platform before creating cache', async () => { const s = setup({ platform: 'linux' }); await expect(s.ensureRuntime({ runtimeDir: s.runtimeDir })).rejects.toThrow('unsupported platform'); expect(s.download).not.toHaveBeenCalled() })
  it('reports insufficient disk space without download', async () => { const s = setup({ availableBytes: async () => 0 }); await expect(s.ensureRuntime({ runtimeDir: s.runtimeDir })).rejects.toThrow('disk space'); expect(s.download).not.toHaveBeenCalled() })
  it('reports permission errors without publishing', async () => { const s = setup({ availableBytes: async () => { throw Object.assign(Error('permission denied'), { code: 'EACCES' }) } }); await expect(s.ensureRuntime({ runtimeDir: s.runtimeDir })).rejects.toThrow('permission denied'); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined() })
  it('does not follow versions-parent symlink in sync cache lookup or preparation', async () => {
    const s = setup(); await fs.mkdir(s.runtimeDir); await fs.symlink(temp(), join(s.runtimeDir, 'versions'))
    expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined(); await expect(s.ensureRuntime({ runtimeDir: s.runtimeDir })).rejects.toThrow('symlink')
  })
  it('multiple stale-owner contenders still perform exactly one download', async () => {
    const s = setup(); await fs.mkdir(join(s.runtimeDir, '.install-lock'), { recursive: true }); await fs.writeFile(join(s.runtimeDir, '.install-lock/owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead', startTime: 1 }))
    const contenders = Array.from({ length: 5 }, () => createBootstrapForTesting(source, s.deps))
    await Promise.all(contenders.map(a => a.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true }))); expect(s.download).toHaveBeenCalledTimes(1)
  })
  it('detaches release with a live reclaim guard and preserves the next owner during tomb cleanup', async () => {
    const preparing = barrier(), finishPreparation = barrier(), guardReady = barrier(), finishGuard = barrier()
    const removing = barrier(), finishRemoval = barrier(), nextPreparing = barrier(), finishNext = barrier()
    const controller = new AbortController()
    let tomb = '', oldToken = '', guardToken = ''
    const s = await localSetup(true, {
      verifySigned: async () => { preparing.resolve(); await finishPreparation.promise },
      lockFs: { ...fs, rm: async (path, options) => {
        // A real guard is held at the old inode when release starts. With the old
        // public-path rm this assertion fails deterministically, not probabilistically.
        tomb = String(path)
        removing.resolve(); await finishRemoval.promise
        await fs.rm(path, options)
      } },
    })
    const directory = join(s.runtimeDir, '.install-lock'), guardFile = join(directory, '.reclaim/owner.json')
    const waiting = createBootstrapForTesting(source, { ...s.deps, lockFs: { ...fs, writeFile: async (path, data, options) => {
      await fs.writeFile(path, data, options)
      if (String(path) === guardFile) { guardToken = JSON.parse(String(data)).token; guardReady.resolve(); await finishGuard.promise }
    } } })
    const next = createBootstrapForTesting(source, { ...s.deps, verifySigned: async () => {}, lockFs: undefined,
      download: async (_source, file) => { nextPreparing.resolve(); await finishNext.promise; await fs.writeFile(file, bytes) },
    })
    const localTask = s.ensureRuntime({ runtimeDir: s.runtimeDir })
    const tasks: Promise<unknown>[] = [localTask]
    try {
      await preparing.promise
      const waitingTask = waiting.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true, signal: controller.signal })
      const cancelled = expect(waitingTask).rejects.toMatchObject({ name: 'AbortError' }); tasks.push(cancelled)
      await guardReady.promise
      // Recursive removal must never follow a symlink out of the owned tomb.
      const sentinel = join(temp(), 'sentinel'); await put(sentinel, 'untouched')
      await fs.symlink(dirname(sentinel), join(directory, '.reclaim/outside'))
      finishPreparation.resolve(); await removing.promise
      expect(dirname(tomb)).toBe(s.runtimeDir)
      expect(tomb).toMatch(/\/\.released-lock-[a-f0-9-]+$/)
      oldToken = JSON.parse(await fs.readFile(join(tomb, 'owner.json'), 'utf8')).token
      expect(JSON.parse(await fs.readFile(join(tomb, '.reclaim/owner.json'), 'utf8')).token).toBe(guardToken)
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
      const nextTask = next.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true }); tasks.push(nextTask)
      await nextPreparing.promise
      const nextIdentity = await fs.stat(directory), nextOwner = await fs.readFile(join(directory, 'owner.json'), 'utf8')
      expect(JSON.parse(nextOwner).token).not.toBe(oldToken)
      await put(guardFile, JSON.stringify({ pid: process.pid, token: 'next-guard', startTime: Date.now() }))
      // The delayed old reclaimer sees the new live owner, and its guard-token
      // cleanup must not remove either the replacement directory or its contents.
      controller.abort(Error('stop contender')); finishGuard.resolve(); await cancelled
      finishRemoval.resolve(); expect((await localTask).provenance?.kind).toBe('local')
      expect((await fs.stat(directory)).ino).toBe(nextIdentity.ino)
      expect(await fs.readFile(join(directory, 'owner.json'), 'utf8')).toBe(nextOwner)
      expect(JSON.parse(await fs.readFile(guardFile, 'utf8')).token).toBe('next-guard')
      await expect(fs.stat(tomb)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await fs.readFile(sentinel, 'utf8')).toBe('untouched')
      finishNext.resolve(); expect((await nextTask).provenance).toBeUndefined()
      expect(await fs.readdir(s.runtimeDir)).toEqual(['versions'])
    } finally {
      controller.abort(Error('stop contender'))
      for (const gate of [finishPreparation, finishGuard, finishRemoval, finishNext]) gate.resolve()
      await Promise.allSettled(tasks)
    }
  })
  it('does not rename or remove a lock whose owner token changed before release', async () => {
    const rename = vi.fn(fs.rename), s = setup({ lockFs: { ...fs, rename }, availableBytes: async root => {
      const file = join(root, '.install-lock/owner.json'), owner = JSON.parse(await fs.readFile(file, 'utf8'))
      await fs.writeFile(file, JSON.stringify({ ...owner, token: 'replacement-owner' }))
      return 0
    } })
    await expect(s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })).rejects.toThrow('disk space')
    expect(rename).not.toHaveBeenCalled()
    expect(JSON.parse(await fs.readFile(join(s.runtimeDir, '.install-lock/owner.json'), 'utf8')).token).toBe('replacement-owner')
    expect(await fs.readdir(s.runtimeDir)).toEqual(['.install-lock'])
  })
  it('real HTTP streaming path verifies exact small pinned bytes, without network', async () => {
    const s = setup(); const fetch = vi.fn(async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length), 'content-type': 'application/zip' } })); vi.stubGlobal('fetch', fetch)
    const { download: _unused, ...overrides } = s.deps; const real = createBootstrapForTesting(source, overrides)
    await real.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true }); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['html', 'wrong-size', 'over-cap', 'wrong-hash'])('real HTTP rejects %s before extraction', async mode => {
    const s = setup(); const data = mode === 'over-cap' ? Buffer.concat([bytes, bytes]) : mode === 'wrong-hash' ? Buffer.alloc(bytes.length) : bytes
    vi.stubGlobal('fetch', vi.fn(async () => new Response(data, { status: 200, headers: mode === 'html' ? { 'content-type': 'text/html' } : mode === 'wrong-size' ? { 'content-length': '1' } : {} })))
    const { download: _unused, ...overrides } = s.deps; const real = createBootstrapForTesting(source, overrides)
    await expect(real.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })).rejects.toThrow(); expect(s.unpack).not.toHaveBeenCalled(); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined()
  })
  it('rejects filesystem and home roots before chmod', () => { expect(() => resolveRuntimeRoot('/')).toThrow('filesystem root'); expect(() => resolveRuntimeRoot(homedir())).toThrow('home directory') })
  it('rejects relative runtime roots', () => { expect(() => resolveRuntimeRoot('relative-cache')).toThrow('absolute path') })
  it('real HTTP implementation rejects off-host redirect without following it', async () => {
    const s = setup(); const fetch = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://attacker.invalid/payload.zip' } })); vi.stubGlobal('fetch', fetch)
    // Omit mock download to exercise the real implementation, without a real network request.
    const real = createBootstrapForTesting(source, { platform: 'darwin', arch: 'arm64', availableBytes: async () => 1024 ** 3 })
    await expect(real.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })).rejects.toThrow('redirect'); expect(fetch).toHaveBeenCalledTimes(1)
  })
})

async function localSetup(canonical = true, extra: Parameters<typeof createBootstrapForTesting>[1] = {}) {
  const sourceApp = join(temp(), 'ChatGPT.app'), codexHome = join(temp(), 'codex-home')
  await fixture(sourceApp)
  const bundled = join(sourceApp, 'Contents/Resources/cua_node/lib/node_modules/@oai/sky', APP)
  const canonicalApp = join(codexHome, 'computer-use', APP)
  if (canonical) { await fs.mkdir(dirname(canonicalApp), { recursive: true }); await fs.cp(bundled, canonicalApp, { recursive: true }) }
  const copy = vi.fn(async (a: string, b: string) => { await fs.cp(a, b, { recursive: true, verbatimSymlinks: true }) })
  const s = setup({ localCandidates: () => [sourceApp], localHomes: () => [codexHome], copy, ...extra })
  return { ...s, sourceApp, codexHome, canonicalApp, bundled, copy }
}
describe('direct installed cohort reuse (all signatures mocked, no native execution)', () => {
  it('complete local components use direct paths with zero copy/download even with no download space', async () => {
    const s = await localSetup(true, { availableBytes: async () => 0 })
    const p = await s.ensureRuntime({ runtimeDir: s.runtimeDir })
    expect(p.nodePath).toBe(join(s.sourceApp, 'Contents/Resources/cua_node/bin/node'))
    expect(p.cliPath).toBe(join(s.sourceApp, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'))
    expect(p.appPath).toBe(s.canonicalApp); expect(p.codexHome).toBe(s.codexHome)
    expect(p.provenance).toEqual({ kind: 'local', sourceApp: s.sourceApp })
    expect(s.copy).not.toHaveBeenCalled(); expect(s.download).not.toHaveBeenCalled(); expect(s.unpack).not.toHaveBeenCalled()
    expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p)
    expect(await fs.readdir(s.runtimeDir)).toEqual(['local-ready.json'])
  })
  it('missing canonical copies only CU to owned home, never node/CLI or home data', async () => {
    const s = await localSetup(false)
    const p = await s.ensureRuntime({ runtimeDir: s.runtimeDir })
    expect(s.copy).toHaveBeenCalledTimes(1); expect(s.copy.mock.calls[0]![0]).toBe(s.bundled)
    expect(p.codexHome).toBe(join(s.runtimeDir, 'local', source.id, 'home'))
    expect(p.nodePath).toContain(s.sourceApp); expect(p.cliPath).toContain(s.sourceApp)
    expect(await fs.readdir(p.codexHome)).toEqual(['computer-use']); expect(s.download).not.toHaveBeenCalled()
    expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p)
    await s.ensureRuntime({ runtimeDir: s.runtimeDir }); expect(s.copy).toHaveBeenCalledTimes(1)
  })
  it('cross-instance marker bridges exactly the verified paths, outside managed cache boundary', async () => {
    const s = await localSetup(), p = await s.ensureRuntime({ runtimeDir: s.runtimeDir })
    const second = createBootstrapForTesting(source, s.deps)
    expect(second.readPreparedRuntime(s.runtimeDir)).toEqual(p)
    await second.ensureRuntime({ runtimeDir: s.runtimeDir }); expect(s.copy).not.toHaveBeenCalled(); expect(s.download).not.toHaveBeenCalled()
  })
  it('concurrent independent instances make only one minimal CU copy', async () => {
    const s = await localSetup(false), second = createBootstrapForTesting(source, s.deps)
    const [a, b] = await Promise.all([s.ensureRuntime({ runtimeDir: s.runtimeDir }), second.ensureRuntime({ runtimeDir: s.runtimeDir })])
    expect(a).toEqual(b); expect(s.copy).toHaveBeenCalledTimes(1); expect(second.readPreparedRuntime(s.runtimeDir)).toEqual(b)
  })
  it('defaults prefer verified local even when a complete managed cache exists', async () => {
    const s = await localSetup(), managed = await s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })
    const local = await s.ensureRuntime({ runtimeDir: s.runtimeDir }); expect(local.appPath).toBe(s.canonicalApp)
    expect(local.nodePath).not.toBe(managed.nodePath); expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(local)
    expect(s.download).toHaveBeenCalledTimes(1)
  })
  it.each(['wrong-version', 'missing-cli', 'missing-node', 'missing-CU', 'not-executable', 'bad-signature', 'escaping-link'])('incompatible %s falls back to valid managed cache, with reason logged', async mode => {
    const s = await localSetup(), p = await s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })
    if (mode === 'wrong-version') s.deps.appVersion = async app => app === s.sourceApp ? '99.0' : source.appVersion
    if (mode === 'missing-cli') await fs.unlink(join(s.sourceApp, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'))
    if (mode === 'missing-node') await fs.unlink(join(s.sourceApp, 'Contents/Resources/cua_node/bin/node'))
    if (mode === 'missing-CU') await fs.rm(s.bundled, { recursive: true })
    if (mode === 'not-executable') await fs.chmod(join(s.sourceApp, 'Contents/Resources/cua_node/bin/node'), 0o644)
    if (mode === 'bad-signature') s.deps.verifySigned = async path => { if (path.startsWith(s.sourceApp)) throw Error('apple anchor/leaf OU rejected') }
    if (mode === 'escaping-link') await fs.symlink(temp(), join(s.sourceApp, 'Contents/Resources/cua_node/escape'))
    const api = createBootstrapForTesting(source, s.deps), log = vi.fn()
    expect(await api.ensureRuntime({ runtimeDir: s.runtimeDir, log })).toEqual(p)
    expect(log.mock.calls.flat().join(' ')).toContain('incompatible/incomplete')
    expect(s.download).toHaveBeenCalledTimes(1); expect(api.readPreparedRuntime(s.runtimeDir)).toEqual(p)
  })
  it('unverified latest is not accepted and downloads only when no valid cache exists', async () => {
    const s = await localSetup(true, { appVersion: async () => '99.0' })
    const api = createBootstrapForTesting(source, { ...s.deps, appVersion: async app => app === s.sourceApp ? '99.0' : source.appVersion })
    const p = await api.ensureRuntime({ runtimeDir: s.runtimeDir })
    expect(p.provenance).toBeUndefined(); expect(s.download).toHaveBeenCalledTimes(1)
  })
  it('rejects local node code signature and uses managed download rather than copying untrusted binaries', async () => {
    const s = await localSetup(true, { verifySigned: async path => { if (path.includes('/ChatGPT.app/Contents/Resources/cua_node/bin/node') && !path.includes('/extracted/')) throw Error('invalid local node signature') } })
    const log = vi.fn(), p = await s.ensureRuntime({ runtimeDir: s.runtimeDir, log })
    expect(p.provenance).toBeUndefined(); expect(s.download).toHaveBeenCalledTimes(1)
    expect(log.mock.calls.flat().join(' ')).toContain('invalid local node signature')
  })
  it.each(['client-hash', 'service-hash', 'signature'])('canonical CU %s mismatch never borrows user CU or overwrites it', async mode => {
    const s = await localSetup()
    const client = join(s.canonicalApp, 'Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient')
    if (mode === 'client-hash') await fs.writeFile(client, 'different-client')
    if (mode === 'service-hash') await fs.writeFile(join(s.canonicalApp, 'Contents/MacOS/SkyComputerUseService'), 'different-service')
    const api = createBootstrapForTesting(source, { ...s.deps, verifySigned: async path => { if (mode === 'signature' && path === s.canonicalApp) throw Error('invalid canonical signature') } })
    const p = await api.ensureRuntime({ runtimeDir: s.runtimeDir })
    expect(p.appPath).not.toBe(s.canonicalApp); expect(s.copy).toHaveBeenCalledTimes(1); expect(s.download).not.toHaveBeenCalled()
    expect(await fs.readFile(client, 'utf8')).toBe(mode === 'client-hash' ? 'different-client' : 'fixture')
  })
  it.each(['source-removed', 'node-corrupted', 'client-corrupted', 'execute-bit-removed'])('sync marker invalidates %s and ensure revalidates/falls back instead of stale paths', async mode => {
    const s = await localSetup(), managed = await s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true }), p = await s.ensureRuntime({ runtimeDir: s.runtimeDir })
    s.copy.mockClear()
    if (mode === 'source-removed') await fs.rm(s.sourceApp, { recursive: true })
    if (mode === 'node-corrupted') await fs.writeFile(p.nodePath, 'bad-node')
    if (mode === 'client-corrupted') await fs.writeFile(p.clientPath, 'bad-client')
    if (mode === 'execute-bit-removed') await fs.chmod(p.nodePath, 0o644)
    expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(managed)
    // Mock the actual signature rejection a corrupted source would produce in production.
    const api = createBootstrapForTesting(source, { ...s.deps, verifySigned: async path => { if (mode === 'node-corrupted' && path === s.sourceApp) throw Error('resource seal changed') } })
    const next = await api.ensureRuntime({ runtimeDir: s.runtimeDir })
    if (mode === 'client-corrupted') { expect(next.nodePath).toBe(p.nodePath); expect(next.appPath).not.toBe(p.appPath); expect(s.copy).toHaveBeenCalledTimes(1) }
    else expect(next).toEqual(managed)
    expect(api.readPreparedRuntime(s.runtimeDir)).toEqual(next); expect(s.download).toHaveBeenCalledTimes(1)
  })
  it('every ensure rechecks signatures and version even after a valid marker', async () => {
    const s = await localSetup(), p = await s.ensureRuntime({ runtimeDir: s.runtimeDir })
    s.verifySigned.mockClear(); await s.ensureRuntime({ runtimeDir: s.runtimeDir })
    expect(s.verifySigned).toHaveBeenCalledWith(s.sourceApp, source.teamIdentifier, undefined)
    expect(s.verifySigned).toHaveBeenCalledWith(p.nodePath, source.teamIdentifier, undefined)
    const api = createBootstrapForTesting(source, { ...s.deps, appVersion: async app => app === s.sourceApp ? 'changed' : source.appVersion })
    expect((await api.ensureRuntime({ runtimeDir: s.runtimeDir })).provenance).toBeUndefined()
  })
  it('skipLocal never consults local candidates/homes or marker, and publishes managed selection', async () => {
    const s = await localSetup(); await s.ensureRuntime({ runtimeDir: s.runtimeDir })
    const api = createBootstrapForTesting(source, { ...s.deps, localCandidates: () => { throw Error('must not inspect local') }, localHomes: () => { throw Error('must not inspect local') } })
    const p = await api.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })
    expect(p.provenance).toBeUndefined(); expect(await fs.readdir(s.runtimeDir)).toEqual(['versions'])
    expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p); expect(s.download).toHaveBeenCalledTimes(1)
  })
  it('force refreshes managed runtime, including after local and after valid cache', async () => {
    const s = await localSetup(); await s.ensureRuntime({ runtimeDir: s.runtimeDir })
    const p = await s.ensureRuntime({ runtimeDir: s.runtimeDir, force: true, sourceApp: s.sourceApp })
    expect(p.provenance).toBeUndefined(); expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p)
    await s.ensureRuntime({ runtimeDir: s.runtimeDir, force: true }); expect(s.download).toHaveBeenCalledTimes(2)
  })
  it('explicit managed archive overrides automatic local reuse', async () => {
    const s = await localSetup(), archivePath = join(temp(), 'pinned.zip'); await fs.writeFile(archivePath, bytes)
    const p = await s.ensureRuntime({ runtimeDir: s.runtimeDir, archivePath })
    expect(p.provenance).toBeUndefined(); expect(s.copy).toHaveBeenCalledTimes(3); expect(s.download).not.toHaveBeenCalled()
  })
  it.each(['unrelated-home', 'relative-source', 'unrelated-hash-path', 'wrong-cohort'])('refuses tampered local marker %s', async mode => {
    const s = await localSetup(); await s.ensureRuntime({ runtimeDir: s.runtimeDir })
    const file = join(s.runtimeDir, 'local-ready.json'), m = JSON.parse(await fs.readFile(file, 'utf8'))
    if (mode === 'unrelated-home') m.codexHome = temp()
    if (mode === 'relative-source') m.sourceApp = 'relative/ChatGPT.app'
    if (mode === 'unrelated-hash-path') m.hashes[join(temp(), 'arbitrary')] = 'a'.repeat(64)
    if (mode === 'wrong-cohort') m.id = 'another-cohort'
    await fs.writeFile(file, JSON.stringify(m)); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined()
  })
  it('skipLocal discards a malicious marker symlink without following it', async () => {
    const s = await localSetup(), sentinel = join(temp(), 'sentinel')
    await fs.mkdir(s.runtimeDir); await fs.writeFile(sentinel, 'must not read or alter')
    await fs.symlink(sentinel, join(s.runtimeDir, 'local-ready.json'))
    const p = await s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })
    expect(p.provenance).toBeUndefined(); expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p)
    expect(await fs.readFile(sentinel, 'utf8')).toBe('must not read or alter')
  })
  it.each(['source-executable', 'source-version', 'source-seal'])('sync marker rejects altered %s metadata before ensure', async mode => {
    const s = await localSetup()
    const seal = join(s.sourceApp, 'Contents/_CodeSignature/CodeResources')
    if (mode === 'source-seal') await put(seal, 'signed-seal')
    await s.ensureRuntime({ runtimeDir: s.runtimeDir })
    if (mode === 'source-executable') await fs.writeFile(join(s.sourceApp, 'Contents/MacOS/ChatGPT'), 'changed-executable')
    if (mode === 'source-version') await fs.writeFile(join(s.sourceApp, 'Contents/Info.plist'), '99.0')
    if (mode === 'source-seal') await fs.unlink(seal)
    expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined()
  })
  it('isolates different in-process policies instead of lending a local flight to skipLocal', async () => {
    const localPreparing = barrier(), finishLocal = barrier()
    const s = await localSetup(true, { verifySigned: async () => { localPreparing.resolve(); await finishLocal.promise } })
    const localTask = s.ensureRuntime({ runtimeDir: s.runtimeDir })
    // Starting both calls together does not guarantee mkdir acquisition order.
    // Hold the local owner so managed really contends and is the final publisher.
    await localPreparing.promise
    const managedTask = s.ensureRuntime({ runtimeDir: s.runtimeDir, skipLocal: true })
    finishLocal.resolve()
    const [local, managed] = await Promise.all([localTask, managedTask])
    expect(local.provenance?.kind).toBe('local'); expect(managed.provenance).toBeUndefined(); expect(s.download).toHaveBeenCalledTimes(1)
    expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(managed)
  })
})


describe('public ensureRuntime/readPreparedRuntime selection API', () => {
  it.each(['valid', 'wrong-identifier', 'wrong-team', 'signature-rejected', 'old-macOS'])('uses the real public wiring with mocked native commands: %s', async mode => {
    const s = await localSetup()
    const calls: Array<{ command: string; args: string[] }> = []
    const execFile = vi.fn()
    Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), { value: async (command: string, args: string[]) => {
      calls.push({ command, args })
      if (command === '/usr/bin/sw_vers') return { stdout: mode === 'old-macOS' ? '14.3' : '15.0', stderr: '' }
      if (command === '/usr/libexec/PlistBuddy') return { stdout: source.appVersion, stderr: '' }
      if (command === '/usr/bin/codesign') {
        if (args.includes('--verify')) {
          if (mode === 'signature-rejected') throw Error('apple anchor requirement rejected')
          return { stdout: '', stderr: '' }
        }
        const path = args.at(-1)!, id = path === s.sourceApp ? 'com.openai.codex' : path.endsWith('/node') ? 'node' : path.endsWith('/CodexCLI.app') ? 'codex' : 'com.openai.sky.CUAService'
        return { stdout: '', stderr: 'TeamIdentifier=' + (mode === 'wrong-team' ? 'UNTRUSTED' : source.teamIdentifier) + '\nIdentifier=' + (mode === 'wrong-identifier' ? 'unrelated.app' : id) + '\n' }
      }
      throw Error('Unexpected native command (no copy, download, launch permitted): ' + command)
    } })
    vi.resetModules(); vi.doMock('node:child_process', () => ({ execFile })); vi.stubEnv('CODEX_HOME', s.codexHome)
    try {
      const publicApi = await import('../src/bootstrap.ts')
      if (mode === 'valid') {
        const p = await publicApi.ensureRuntime({ runtimeDir: s.runtimeDir, sourceApp: s.sourceApp })
        expect(p.nodePath).toBe(join(s.sourceApp, 'Contents/Resources/cua_node/bin/node'))
        expect(p.cliPath).toBe(join(s.sourceApp, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'))
        expect(p.appPath).toBe(s.canonicalApp); expect(p.codexHome).toBe(s.codexHome)
        expect(publicApi.readPreparedRuntime(s.runtimeDir)).toEqual(p)
        // A separate process has no in-memory selection and must obtain the identical bridge paths.
        const code = 'import { readPreparedRuntime } from ' + JSON.stringify(new URL('../src/bootstrap.ts', import.meta.url).href) + '; console.log(JSON.stringify(readPreparedRuntime(' + JSON.stringify(s.runtimeDir) + ')))'
        const child = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: s.codexHome } })
        expect(JSON.parse(child.trim())).toEqual(p)
        expect(calls.some(c => c.command === '/usr/bin/ditto')).toBe(false)
        for (const call of calls.filter(c => c.args.includes('--verify'))) {
          expect(call.args).toContain('--strict'); expect(call.args).toContain('--test-requirement')
          expect(call.args).toContain('=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"')
        }
      } else {
        const message = mode === 'wrong-identifier' ? 'identifier mismatch' : mode === 'wrong-team' ? 'team mismatch' : mode === 'old-macOS' ? 'macOS 14.4' : 'anchor requirement rejected'
        await expect(publicApi.ensureRuntime({ runtimeDir: s.runtimeDir, sourceApp: s.sourceApp })).rejects.toThrow(message)
        expect(publicApi.readPreparedRuntime(s.runtimeDir)).toBeUndefined()
      }
    } finally { vi.doUnmock('node:child_process'); vi.unstubAllEnvs(); vi.resetModules() }
  })
})

function zip(entries: Array<{ name: string; target?: string }>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.from(e.target ?? 'file'), local = Buffer.alloc(30), central = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((e.target ? 0xa1ff : 0x81a4) * 65536) >>> 0, 38); central.writeUInt32LE(offset, 42)
    locals.push(local, name, data); centrals.push(central, name); offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
describe('read-only ZIP central directory guard', () => {
  it.each(['../escape', '/absolute', 'a/../../escape', 'C:/drive', 'a\\escape'])('rejects traversal path %s', async name => { const p = join(temp(), 'a.zip'); await fs.writeFile(p, zip([{ name }])); await expect(inspectRuntimeZip(p)).rejects.toThrow('Unsafe') })
  it('accepts bounded relative symlink', async () => { const p = join(temp(), 'a.zip'); await fs.writeFile(p, zip([{ name: 'a/target' }, { name: 'a/link', target: 'target' }])); expect(await inspectRuntimeZip(p)).toBeGreaterThan(0) })
  it.each(['../../escape', '/absolute'])('rejects escaping link %s', async target => { const p = join(temp(), 'a.zip'); await fs.writeFile(p, zip([{ name: 'a/link', target }])); await expect(inspectRuntimeZip(p)).rejects.toThrow('symlink') })
  it('rejects files underneath symlinks', async () => { const p = join(temp(), 'a.zip'); await fs.writeFile(p, zip([{ name: 'a/link', target: 'target' }, { name: 'a/link/child' }])); await expect(inspectRuntimeZip(p)).rejects.toThrow('traverses a symlink') })
})
