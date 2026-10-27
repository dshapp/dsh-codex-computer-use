import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBootstrapForTesting, type RuntimeSource } from '../src/bootstrap.ts'
import { RangeUnsupportedError, type ComponentId, type RangeManifest } from '../src/range-runtime.ts'
const roots: string[] = []
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })
function temp() { const p = realpathSync(mkdtempSync(join(tmpdir(), 'minimal-bootstrap-'))); roots.push(p); return p }
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const full = Buffer.from('whole official ZIP fixture')
const source: RuntimeSource = { id: 'minimal-fixture', appVersion: '26.1007.30912', platform: 'darwin', arch: 'arm64', url: 'https://persistent.oaistatic.com/codex-app-prod/fixture.zip', sha256: sha(full), bytes: full.length, teamIdentifier: '2DC432GLL2', layoutVersion: 1 }
const APP = 'Codex Computer Use.app', CU = 'cua_node/lib/node_modules/@oai/sky/' + APP
const CLIENT = 'Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'
const bases = { node: 'cua_node', cli: 'codex-cli/CodexCLI.app', cu: CU }
const files: Array<{ group: ComponentId; name: string; value: string; kind: 'file' | 'symlink'; mode: number }> = []
function add(group: ComponentId, name: string, kind: 'file' | 'symlink' = 'file', value = name) { files.push({ group, name, kind, value, mode: kind === 'symlink' ? 0o755 : name === 'bin/node' || name.includes('/MacOS/') ? 0o755 : 0o644 }) }
add('node', 'bin/node'); add('node', 'LICENSE')
for (const n of ['Contents/MacOS/codex', 'Contents/Info.plist', 'Contents/_CodeSignature/CodeResources', 'Contents/embedded.provisionprofile']) add('cli', n)
add('cli', 'Contents/CodeResources', 'symlink', '_CodeSignature/CodeResources')
for (const n of ['Contents/MacOS/SkyComputerUseService', CLIENT, 'Contents/Info.plist', 'Contents/_CodeSignature/CodeResources', 'Contents/embedded.provisionprofile', 'Contents/Resources/resource.bin', 'Contents/SharedSupport/SkyComputerUseClient.app/Contents/_CodeSignature/CodeResources']) add('cu', n)
const manifest: RangeManifest = { version: 1, sourceSha256: source.sha256, sourceBytes: source.bytes, centralDirectory: { offset: 1, bytes: 1, sha256: sha('central') }, entries: files.map((f, i) => ({ name: 'ChatGPT.app/Contents/Resources/' + bases[f.group] + '/' + f.name, component: f.group, localOffset: i, compressedBytes: Buffer.byteLength(f.value), bytes: Buffer.byteLength(f.value), sha256: sha(f.value), uncompressedSha256: sha(f.value), kind: f.kind, mode: f.mode })) }
async function put(path: string, data: string, mode = 0o644) { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, data, { mode }); await fs.chmod(path, mode) }
async function fixture(app: string, groups: ComponentId[] = ['node', 'cli', 'cu'], legacy = false) {
  await put(join(app, 'Contents/Info.plist'), source.appVersion)
  await put(join(app, 'Contents/MacOS/ChatGPT'), 'signed-main', 0o755)
  for (const f of files.filter(f => groups.includes(f.group))) { const p = join(app, 'Contents/Resources', bases[f.group], f.name); if (f.kind === 'symlink') { await fs.mkdir(dirname(p), { recursive: true }); await fs.symlink(f.value, p) } else await put(p, f.value, f.mode) }
  if (legacy) { await put(join(app, 'Contents/Resources/cua_node/bin/node_repl'), 'extra', 0o755); await put(join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/sky/package.json'), '{}') }
}
function setup(extra: Parameters<typeof createBootstrapForTesting>[1] = {}) {
  const runtimeDir = join(temp(), 'runtime')
  const download = vi.fn(async (_s, file: string) => { await fs.writeFile(file, full) })
  const downloadMinimalZip = vi.fn(async (_s, _m, file: string, groups: ComponentId[]) => { await fs.writeFile(file, JSON.stringify(groups)); return { downloadedBytes: 50 } })
  const verifySigned = vi.fn(async (_path: string, _team: string, _signal?: AbortSignal) => {})
  const unpack = vi.fn(async (archive: string, destination: string) => { const b = await fs.readFile(archive); const legacy = b.equals(full); await fixture(join(destination, 'ChatGPT.app'), legacy ? ['node', 'cli', 'cu'] : JSON.parse(b.toString()), legacy) })
  const deps = { manifest: () => manifest, downloadMinimalZip, download, verifySigned, unpack, platform: 'darwin', arch: 'arm64', localCandidates: () => [], localHomes: () => [], appVersion: async () => source.appVersion, inspectZip: async () => 1024, availableBytes: async () => 1024 ** 3, copy: async (s: string, d: string) => { await fs.cp(s, d, { recursive: true, verbatimSymlinks: true }) }, lockPollMs: 5, lockWaitMs: 1000, ...extra }
  return { ...createBootstrapForTesting(source, deps), runtimeDir, deps, downloadMinimalZip, download, verifySigned, unpack }
}
const options = (s: ReturnType<typeof setup>) => ({ runtimeDir: s.runtimeDir })
describe('production minimal runtime branch', () => {
  it('cold downloads exactly three groups, no node_repl or JS; sync reconstructs and cache downloads nothing', async () => {
    const s = setup(), p = await s.ensureRuntime(options(s))
    expect(s.downloadMinimalZip.mock.calls[0]![3]).toEqual(['node', 'cli', 'cu']); expect(s.download).not.toHaveBeenCalled()
    expect(await fs.readdir(join(p.releaseDir, 'cua_node/bin'))).toEqual(['node']); expect(await fs.readdir(p.codexHome)).toEqual(['computer-use'])
    expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p); expect(await s.ensureRuntime(options(s))).toEqual(p); expect(s.downloadMinimalZip).toHaveBeenCalledTimes(1)
    expect(s.verifySigned.mock.calls.some(c => /\/(ChatGPT|Codex)\.app$/.test(String(c[0])))).toBe(false)
  })
  it('complete original cohort still uses unchanged legacy direct selection', async () => {
    const app = join(temp(), 'ChatGPT.app'); await fixture(app, ['node', 'cli', 'cu'], true)
    const s = setup({ localCandidates: () => [app] }), p = await s.ensureRuntime(options(s))
    expect(p.nodePath).toBe(join(app, 'Contents/Resources/cua_node/bin/node')); expect(p.provenance?.sourceApp).toBe(app); expect(s.downloadMinimalZip).not.toHaveBeenCalled(); expect(s.download).not.toHaveBeenCalled()
  })
  it('partial original node+CLI reuse keeps original paths and requests CU only', async () => {
    const app = join(temp(), 'Codex.app'); await fixture(app, ['node', 'cli'])
    const s = setup({ localCandidates: () => [app] }), p = await s.ensureRuntime(options(s))
    expect(s.downloadMinimalZip.mock.calls[0]![3]).toEqual(['cu']); expect(p.nodePath).toBe(join(app, 'Contents/Resources/cua_node/bin/node')); expect(p.cliPath).toBe(join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')); expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p)
  })
  it('only missing node is fetched with original CLI and permitted canonical CU', async () => {
    const app = join(temp(), 'Codex.app'), home = join(temp(), '.codex'); await fixture(app, ['cli', 'cu']); await fs.mkdir(join(home, 'computer-use'), { recursive: true }); await fs.cp(join(app, 'Contents/Resources', CU), join(home, 'computer-use', APP), { recursive: true, verbatimSymlinks: true }); await fs.rm(join(app, 'Contents/Resources', CU), { recursive: true })
    const s = setup({ localCandidates: () => [app], localHomes: () => [home] }), p = await s.ensureRuntime(options(s))
    expect(s.downloadMinimalZip.mock.calls[0]![3]).toEqual(['node']); expect(p.codexHome).toBe(join(p.releaseDir, 'home')); expect(p.appPath).not.toBe(join(home, 'computer-use', APP)); expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p)
  })
  it('hybrid canonical CU is input-only: auth/config/session data remains untouched and cannot enter owned home', async () => {
    const app = join(temp(), 'Codex.app'), home = join(temp(), '.codex'); await fixture(app, ['cli', 'cu']); await fs.mkdir(join(home, 'computer-use'), { recursive: true }); await fs.cp(join(app, 'Contents/Resources', CU), join(home, 'computer-use', APP), { recursive: true, verbatimSymlinks: true }); await fs.rm(join(app, 'Contents/Resources', CU), { recursive: true }); for (const n of ['auth.json', 'config.toml', 'sessions/private.json']) await put(join(home, n), 'private-sentinel')
    const s = setup({ localCandidates: () => [app], localHomes: () => [home] }), p = await s.ensureRuntime(options(s)); expect(p.codexHome).toBe(join(p.releaseDir, 'home')); expect(s.downloadMinimalZip.mock.calls[0]![3]).toEqual(['node']); expect(await fs.readdir(p.codexHome)).toEqual(['computer-use']); expect(await fs.readFile(join(home, 'auth.json'), 'utf8')).toBe('private-sentinel'); expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p)
  })
  it('a partial bundled CU is copied only into owned home without network', async () => {
    const app = join(temp(), 'ChatGPT.app'); await fixture(app)
    const s = setup({ localCandidates: () => [app] }), p = await s.ensureRuntime(options(s))
    expect(s.downloadMinimalZip).not.toHaveBeenCalled(); expect(p.codexHome).toBe(join(p.releaseDir, 'home')); expect(p.nodePath.startsWith(app)).toBe(true); expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p)
  })
  it('repairs only corrupt managed component and copies survivors before atomic replacement', async () => {
    const s = setup(), p = await s.ensureRuntime(options(s)); await fs.writeFile(p.nodePath, 'corrupt'); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined()
    const repaired = await s.ensureRuntime(options(s)); expect(s.downloadMinimalZip.mock.calls[1]![3]).toEqual(['node']); expect(await fs.readFile(repaired.cliPath, 'utf8')).toBe('Contents/MacOS/codex'); expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(repaired)
  })
  it('deleted external source downloads its components, not whole ZIP', async () => {
    const app = join(temp(), 'Codex.app'); await fixture(app, ['node', 'cli']); const s = setup({ localCandidates: () => [app] }); await s.ensureRuntime(options(s)); await fs.rm(app, { recursive: true }); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined(); await s.ensureRuntime(options(s)); expect(s.downloadMinimalZip.mock.calls[1]![3]).toEqual(['node', 'cli']); expect(s.download).not.toHaveBeenCalled()
  })
  it.each(['hash mismatch', 'path escape', 'redirect mismatch', 'signature failure'])('%s never triggers full fallback', async message => {
    const s = setup({ downloadMinimalZip: async () => { throw Error(message) } }); await expect(s.ensureRuntime(options(s))).rejects.toThrow(message); expect(s.download).not.toHaveBeenCalled(); expect(await fs.readdir(s.runtimeDir)).toEqual([])
  })
  it('native signature failure after unpack never triggers full fallback', async () => {
    const s = setup({ verifySigned: async () => { throw Error('signature failure') } }); await expect(s.ensureRuntime(options(s))).rejects.toThrow('signature failure'); expect(s.download).not.toHaveBeenCalled()
  })
  it('RangeUnsupported alone uses verified whole ZIP and source app then trims', async () => {
    const s = setup({ downloadMinimalZip: async () => { throw new RangeUnsupportedError('200 canceled') } }), p = await s.ensureRuntime(options(s)); expect(s.download).toHaveBeenCalledTimes(1); expect(s.verifySigned.mock.calls.some(c => String(c[0]).endsWith('/ChatGPT.app'))).toBe(true); expect(await fs.readdir(join(p.releaseDir, 'cua_node/bin'))).toEqual(['node']); expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p)
  })
  it('full fallback still rejects whole ZIP hash mismatch', async () => {
    const s = setup({ downloadMinimalZip: async () => { throw new RangeUnsupportedError('416') }, download: async (_s, file) => { await fs.writeFile(file, Buffer.alloc(full.length)) } }); await expect(s.ensureRuntime(options(s))).rejects.toThrow('SHA256'); expect(s.unpack).not.toHaveBeenCalled()
  })
  it('archivePath bypasses ranges but verifies full ZIP before trimming', async () => {
    const archivePath = join(temp(), 'official.zip'); await fs.writeFile(archivePath, full); const s = setup(), p = await s.ensureRuntime({ ...options(s), archivePath }); expect(s.downloadMinimalZip).not.toHaveBeenCalled(); expect(s.download).not.toHaveBeenCalled(); expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p)
  })
  it('force skips all local and managed components', async () => {
    const s = setup(); await s.ensureRuntime(options(s)); await s.ensureRuntime({ ...options(s), force: true }); expect(s.downloadMinimalZip.mock.calls[1]![3]).toEqual(['node', 'cli', 'cu'])
  })
  it('insufficient minimal disk and abort clean staging/lock without full download', async () => {
    const s = setup({ availableBytes: async () => 1 }); await expect(s.ensureRuntime(options(s))).rejects.toThrow('disk space'); expect(s.downloadMinimalZip).not.toHaveBeenCalled(); expect(await fs.readdir(s.runtimeDir)).toEqual([])
    const c = new AbortController(), a = setup({ downloadMinimalZip: async (_s, _m, file) => { await fs.writeFile(file, 'partial'); c.abort(Error('cancelled')); c.signal.throwIfAborted(); return { downloadedBytes: 0 } } }); await expect(a.ensureRuntime({ ...options(a), signal: c.signal })).rejects.toThrow('cancelled'); expect(await fs.readdir(a.runtimeDir)).toEqual([])
  })
  it('fallback rechecks full disk budget before downloading', async () => {
    let n = 0; const s = setup({ availableBytes: async () => ++n === 1 ? 1024 ** 3 : 1, downloadMinimalZip: async () => { throw new RangeUnsupportedError('416') } }); await expect(s.ensureRuntime(options(s))).rejects.toThrow('disk space'); expect(s.download).not.toHaveBeenCalled()
  })
  it.each(['Contents/_CodeSignature/CodeResources', 'Contents/embedded.provisionprofile', 'Contents/Info.plist'])('sync reader rejects changed or deleted CLI %s', async name => {
    const s = setup(), p = await s.ensureRuntime(options(s)); await fs.rm(join(dirname(dirname(dirname(p.cliPath))), name)); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined()
  })
  it('sync reader rejects changed CU resource and forged marker external escape', async () => {
    const s = setup(), p = await s.ensureRuntime(options(s)), file = join(p.releaseDir, 'minimal-ready.json'), marker = JSON.parse(await fs.readFile(file, 'utf8')); await fs.writeFile(join(p.appPath, 'Contents/Resources/resource.bin'), 'changed'); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined(); marker.components.node.path = temp(); await fs.writeFile(file, JSON.stringify(marker)); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined()
  })
  it('sync reader rejects escaping component directory symlink', async () => {
    const s = setup(), p = await s.ensureRuntime(options(s)), bin = dirname(p.nodePath), elsewhere = temp(); await fs.cp(bin, elsewhere, { recursive: true }); await fs.rm(bin, { recursive: true }); await fs.symlink(elsewhere, bin); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined()
  })
  it('failed partial repair preserves the previous release and cleans all staging', async () => {
    const s = setup(), p = await s.ensureRuntime(options(s)); await fs.writeFile(p.nodePath, 'bad-node')
    const failing = createBootstrapForTesting(source, { ...s.deps, downloadMinimalZip: async () => { throw Error('offline') } }); await expect(failing.ensureRuntime(options(s))).rejects.toThrow('offline'); expect(await fs.readFile(p.nodePath, 'utf8')).toBe('bad-node'); expect(await fs.readFile(p.cliPath, 'utf8')).toBe('Contents/MacOS/codex'); expect(await fs.readdir(s.runtimeDir)).toEqual(['versions'])
  })
  it('pinned native permission changes invalidate marker and fetch only the affected group', async () => {
    const s = setup(), p = await s.ensureRuntime(options(s)); await fs.chmod(p.nodePath, 0o644); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined(); await s.ensureRuntime(options(s)); expect(s.downloadMinimalZip.mock.calls[1]![3]).toEqual(['node'])
  })
  it('changed source metadata or deleted CLI seal cannot preserve a partial external selection', async () => {
    const app = join(temp(), 'ChatGPT.app'); await fixture(app, ['node', 'cli']); const s = setup({ localCandidates: () => [app] }); await s.ensureRuntime(options(s)); await fs.rm(join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/_CodeSignature/CodeResources')); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined(); await s.ensureRuntime(options(s)); expect(s.downloadMinimalZip.mock.calls[1]![3]).toEqual(['cli']); await fs.writeFile(join(app, 'Contents/Info.plist'), 'changed'); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined()
  })
  it('escaping downloaded symlink payload fails before publish and never full-falls back', async () => {
    const outside = temp(), s = setup({ unpack: async (_a, destination) => { const app = join(destination, 'ChatGPT.app'); await fixture(app); const link = join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/CodeResources'); await fs.rm(link); await fs.symlink(outside, link) } }); await expect(s.ensureRuntime(options(s))).rejects.toThrow('symlink'); expect(s.download).not.toHaveBeenCalled(); expect(await fs.readdir(s.runtimeDir)).toEqual([])
  })
  it('synchronous selection owns canonical CU copy and rejects removed owned CU or digest changes', async () => {
    const app = join(temp(), 'ChatGPT.app'), home = join(temp(), '.codex'); await fixture(app, ['node', 'cli', 'cu']); await fs.mkdir(join(home, 'computer-use'), { recursive: true }); await fs.cp(join(app, 'Contents/Resources', CU), join(home, 'computer-use', APP), { recursive: true }); await fs.rm(join(app, 'Contents/Resources', CU), { recursive: true }); const s = setup({ localCandidates: () => [app], localHomes: () => [home] }), p = await s.ensureRuntime(options(s)); expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p); const changed = createBootstrapForTesting(source, { ...s.deps, manifest: () => ({ ...manifest, centralDirectory: { ...manifest.centralDirectory, sha256: sha('changed') } }) }); expect(changed.readPreparedRuntime(s.runtimeDir)).toBeUndefined(); await fs.rm(join(home, 'computer-use', APP), { recursive: true }); expect(s.readPreparedRuntime(s.runtimeDir)).toEqual(p); await fs.rm(p.appPath, { recursive: true }); expect(s.readPreparedRuntime(s.runtimeDir)).toBeUndefined()
  })
  it('concurrent independent bootstrap instances share lock and range download', async () => {
    const s = setup(), second = createBootstrapForTesting(source, s.deps); await Promise.all([s.ensureRuntime(options(s)), second.ensureRuntime(options(s))]); expect(s.downloadMinimalZip).toHaveBeenCalledTimes(1)
  })
  it('different manifest SHA and missing manifest preserve full legacy layout', async () => {
    for (const m of [undefined, { ...manifest, sourceSha256: sha('different') }]) { const s = setup({ manifest: () => m }), p = await s.ensureRuntime(options(s)); expect(s.downloadMinimalZip).not.toHaveBeenCalled(); expect(s.download).toHaveBeenCalledTimes(1); expect(await fs.stat(join(p.releaseDir, 'cua_node/bin/node_repl'))).toBeTruthy() }
  })
})
