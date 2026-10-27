import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync, readlinkSync, openSync, readSync, closeSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import type { RuntimePaths, RuntimeSource, RuntimeOptions } from './bootstrap.ts'
import { RangeUnsupportedError, type RangeManifest, type ComponentId, downloadMinimalZip } from './range-runtime.ts'

const PREFIX = 'ChatGPT.app/Contents/Resources/'
const APP = 'Codex Computer Use.app'
const CLIENT = 'Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'
const BASE = { node: 'cua_node', cli: 'codex-cli/CodexCLI.app', cu: 'cua_node/lib/node_modules/@oai/sky/' + APP }
const GROUPS: ComponentId[] = ['node', 'cli', 'cu']
export interface MinimalAdapter {
  localCandidates: () => string[]; localHomes: () => string[]
  appVersion: (app: string, signal?: AbortSignal) => Promise<string>
  verifySigned: (path: string, team: string, signal?: AbortSignal) => Promise<void>
  availableBytes: (root: string) => Promise<number>
  copy: (source: string, destination: string, signal?: AbortSignal) => Promise<void>
  unpack: (archive: string, destination: string, signal?: AbortSignal) => Promise<void>
  downloadMinimalZip: typeof downloadMinimalZip
}
type Origin = { path: string; sourceApp?: string; metadataSha256?: string }
type Selection = Record<ComponentId, Origin>
interface MinimalReady { layout: 'minimal-v1'; id: string; sourceSha256: string; sourceBytes: number; appVersion: string; manifestDigest: string; components: Selection }
const digest = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const within = (root: string, path: string) => { const r = relative(root, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)) }
function canonical(path: string) { if (!isAbsolute(path) || realpathSync(path) !== path) throw Error('Unsafe minimal component path: ' + path) }
function hash(path: string) { const fd = openSync(path, 'r'), h = createHash('sha256'), b = Buffer.allocUnsafe(1024 * 1024); try { let n: number; while ((n = readSync(fd, b, 0, b.length, null))) h.update(b.subarray(0, n)); return h.digest('hex') } finally { closeSync(fd) } }
function entries(m: RangeManifest, group: ComponentId) { return m.entries.filter(e => e.component === group) }
function entryRelative(e: RangeManifest['entries'][number], group: ComponentId) { const n = e.name.replace(/\/$/, ''); const base = PREFIX + BASE[group]; if (n === base && e.kind === 'directory') return ''; if (!n.startsWith(base + '/')) throw Error('Invalid minimal component entry path'); return n.slice(base.length + 1) }
/** A different source belongs to the legacy branch; a matching but malformed manifest fails closed. */
export function matchingManifest(m: RangeManifest | undefined, s: RuntimeSource): RangeManifest | undefined {
  if (!m || m.sourceSha256 !== s.sha256 || m.sourceBytes !== s.bytes) return
  if (s.teamIdentifier !== '2DC432GLL2') throw Error('Minimal runtime signing team must be pinned OpenAI team')
  if (m.version !== 1 || !m.centralDirectory || !/^[a-f0-9]{64}$/.test(m.centralDirectory.sha256)) throw Error('Invalid minimal manifest')
  if (!Array.isArray(m.entries) || m.entries.some(e => !GROUPS.includes(e.component))) throw Error('Invalid minimal component group')
  const seen = new Set<string>()
  for (const g of GROUPS) {
    if (!entries(m, g).length) throw Error('Missing minimal component group')
    for (const e of entries(m, g)) {
      const r = entryRelative(e, g)
      if ((r === '' && e.kind !== 'directory') || r.includes('\\') || r.includes('\0') || (r !== '' && r.split('/').some(p => !p || p === '.' || p === '..')) || seen.has(e.name.normalize('NFC').toLowerCase()) || !/^[a-f0-9]{64}$/.test(e.uncompressedSha256 ?? '') || !['file', 'directory', 'symlink'].includes(e.kind ?? '') || !Number.isSafeInteger(e.bytes) || e.bytes < 0 || !Number.isSafeInteger(e.compressedBytes) || e.compressedBytes < 0 || !Number.isSafeInteger(e.localOffset) || e.localOffset < 0 || !/^[a-f0-9]{64}$/.test(e.sha256) || ((e as typeof e & { mode?: number }).mode !== undefined && (!Number.isInteger((e as typeof e & { mode?: number }).mode) || (e as typeof e & { mode: number }).mode < 0 || (e as typeof e & { mode: number }).mode > 0o777))) throw Error('Invalid minimal pinned entry')
      seen.add(e.name.normalize('NFC').toLowerCase())
      if (g === 'node' && !['', 'bin/node', 'LICENSE', 'bin'].includes(r)) throw Error('Unexpected minimal node entry')
    }
  }
  for (const [g, names] of [['node', ['bin/node', 'LICENSE']], ['cli', ['Contents/MacOS/codex', 'Contents/Info.plist', 'Contents/_CodeSignature/CodeResources', 'Contents/CodeResources', 'Contents/embedded.provisionprofile']], ['cu', ['Contents/MacOS/SkyComputerUseService', CLIENT, 'Contents/Info.plist', 'Contents/_CodeSignature/CodeResources']]] as Array<[ComponentId, string[]]>) for (const n of names) if (!entries(m, g).some(e => entryRelative(e, g) === n)) throw Error('Incomplete pinned minimal component: ' + n)
  return m
}
function checkComponent(m: RangeManifest, group: ComponentId, origin: Origin) {
  canonical(origin.path)
  const expected = new Set<string>()
  for (const e of entries(m, group)) {
    const r = entryRelative(e, group), path = join(origin.path, r); expected.add(r)
    const parts = r.split('/'); for (let i = 1; i < parts.length; i++) expected.add(parts.slice(0, i).join('/'))
    let parent = dirname(path)
    while (parent !== origin.path && within(origin.path, parent)) { if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw Error('Minimal component has symlink directory'); parent = dirname(parent) }
    const st = lstatSync(path), mode = (e as typeof e & { mode?: number }).mode
    if (mode !== undefined && (st.mode & 0o777) !== mode) throw Error('Minimal pinned permission mode mismatch: ' + path)
    if (e.kind === 'directory') { if (!st.isDirectory() || st.isSymbolicLink()) throw Error('Minimal directory type mismatch') }
    else if (e.kind === 'symlink') { const value = readlinkSync(path); if (!st.isSymbolicLink() || !within(origin.path, realpathSync(path)) || digest(value) !== e.uncompressedSha256 || Buffer.byteLength(value) !== e.bytes) throw Error('Minimal symlink hash/path mismatch') }
    else { if (!st.isFile() || st.isSymbolicLink() || !within(origin.path, realpathSync(path)) || st.size !== e.bytes || hash(path) !== e.uncompressedSha256) throw Error('Minimal file hash/type mismatch: ' + path); if ((r === 'bin/node' || r.includes('/MacOS/')) && !(st.mode & 0o111)) throw Error('Minimal binary is not executable') }
  }
  // Node shares its original directory with irrelevant JS: inspect only the pinned bin/node + LICENSE.
  if (group !== 'node') {
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = join(dir, name), r = relative(origin.path, p); if (!expected.has(r)) throw Error('Unexpected minimal bundle file: ' + r); const st = lstatSync(p); if (st.isDirectory() && !st.isSymbolicLink()) walk(p) } }; walk(origin.path)
  }
}
function managed(root: string, s: RuntimeSource): Selection { const dir = join(root, 'versions', s.id); return { node: { path: join(dir, 'cua_node') }, cli: { path: join(dir, BASE.cli) }, cu: { path: join(dir, 'home/computer-use', APP) } } }
function runtime(root: string, s: RuntimeSource, selected: Selection): RuntimePaths { const appPath = selected.cu.path; return { root, releaseDir: join(root, 'versions', s.id), nodePath: join(selected.node.path, 'bin/node'), cliPath: join(selected.cli.path, 'Contents/MacOS/codex'), appPath, codexHome: dirname(dirname(appPath)), clientPath: join(appPath, CLIENT) } }
function pathPolicy(root: string, s: RuntimeSource, d: MinimalAdapter, group: ComponentId, o: Origin, allowCanonicalCU = false) {
  if (!o || typeof o.path !== 'string') throw Error('Invalid minimal origin')
  const owned = managed(root, s)[group].path
  if (o.path === owned) { canonical(join(root, 'versions', s.id)); canonical(o.path); if (o.sourceApp) throw Error('Invalid managed origin'); return }
  if (group === 'cu') { if (!allowCanonicalCU || o.sourceApp || !d.localHomes().some(h => isAbsolute(h) && o.path === join(h, 'computer-use', APP))) throw Error('Unpermitted canonical CU origin'); canonical(dirname(dirname(o.path))); canonical(o.path); return }
  if (!o.sourceApp || ! /\/(ChatGPT|Codex)\.app$/.test(o.sourceApp) || o.path !== join(o.sourceApp, 'Contents/Resources', BASE[group])) throw Error('Unpermitted original component origin')
  canonical(o.sourceApp); canonical(o.path)
  if (!/^[a-f0-9]{64}$/.test(o.metadataSha256 ?? '') || hash(join(o.sourceApp, 'Contents/Info.plist')) !== o.metadataSha256) throw Error('Original app metadata changed')
}
export function readMinimal(root: string, s: RuntimeSource, d: MinimalAdapter, m: RangeManifest, allowExternal = true): RuntimePaths | undefined {
  try {
    canonical(root); canonical(join(root, 'versions')); const dir = join(root, 'versions', s.id); canonical(dir)
    const file = join(dir, 'minimal-ready.json'); if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) return
    const ready = JSON.parse(readFileSync(file, 'utf8')) as MinimalReady
    if (ready.layout !== 'minimal-v1' || ready.id !== s.id || ready.sourceSha256 !== s.sha256 || ready.sourceBytes !== s.bytes || ready.appVersion !== s.appVersion || ready.manifestDigest !== digest(JSON.stringify(m))) return
    if (!allowExternal && GROUPS.some(g => ready.components[g]?.path !== managed(root, s)[g].path)) return
    for (const g of GROUPS) { pathPolicy(root, s, d, g, ready.components[g]); checkComponent(m, g, ready.components[g]) }
    return runtime(root, s, ready.components)
  } catch { return }
}
async function signed(m: RangeManifest, g: ComponentId, o: Origin, s: RuntimeSource, d: MinimalAdapter, signal?: AbortSignal) { signal?.throwIfAborted(); checkComponent(m, g, o); await d.verifySigned(g === 'node' ? join(o.path, 'bin/node') : o.path, s.teamIdentifier, signal); signal?.throwIfAborted() }
/** Called only while bootstrap holds its original atomic installation lock. Undefined means RangeUnsupported only. */
export async function prepareMinimal(root: string, s: RuntimeSource, d: MinimalAdapter, m: RangeManifest, options: RuntimeOptions, fullResources?: string): Promise<RuntimePaths | undefined> {
  const current = managed(root, s), selected = {} as Selection
  const tryOrigin = async (g: ComponentId, o: Origin) => { try { await signed(m, g, o, s, d, options.signal); selected[g] = o; return true } catch { options.signal?.throwIfAborted(); return false } }
  if (!options.force) {
    // A corrupt/missing marker must not discard independently pinned owned components.
    for (const g of GROUPS) await tryOrigin(g, current[g])
    if (!options.skipLocal && !options.archivePath) {
      const markerFile = join(root, 'versions', s.id, 'minimal-ready.json')
      try { if (!lstatSync(markerFile).isFile() || lstatSync(markerFile).isSymbolicLink()) throw Error('Unsafe minimal marker'); const old = JSON.parse(readFileSync(markerFile, 'utf8')) as MinimalReady; for (const g of GROUPS) if (!selected[g]) { try { pathPolicy(root, s, d, g, old.components[g]); if (old.components[g].sourceApp && await d.appVersion(old.components[g].sourceApp!, options.signal) !== s.appVersion) continue; await tryOrigin(g, old.components[g]) } catch { options.signal?.throwIfAborted() } } } catch { options.signal?.throwIfAborted() }
      for (const candidate of d.localCandidates()) {
        try { const app = realpathSync(candidate); canonical(app); if (! /\/(ChatGPT|Codex)\.app$/.test(app) || await d.appVersion(app, options.signal) !== s.appVersion) continue
          for (const g of GROUPS) if (!selected[g]) await tryOrigin(g, { path: join(app, 'Contents/Resources', BASE[g]), sourceApp: app, metadataSha256: hash(join(app, 'Contents/Info.plist')) })
        } catch { options.signal?.throwIfAborted() }
      }
      for (const home of d.localHomes()) if (!selected.cu) { try { const o = { path: join(home, 'computer-use', APP) }; pathPolicy(root, s, d, 'cu', o, true); await tryOrigin('cu', o) } catch { options.signal?.throwIfAborted() } }
    }
  }
  const missing = GROUPS.filter(g => !selected[g])
  const cached = !missing.length ? readMinimal(root, s, d, m, !options.skipLocal) : undefined
  if (cached && JSON.stringify(cached) === JSON.stringify(runtime(root, s, selected))) return cached
  const raw = m.entries.reduce((n, e) => n + e.bytes, 0), packed = entriesFor(m, missing).reduce((n, e) => n + e.compressedBytes + 256 + Buffer.byteLength(e.name), m.centralDirectory.bytes)
  if (await d.availableBytes(root) < raw * 3 + packed * 2 + 1024 * 1024) throw Error('Insufficient disk space for minimal runtime setup')
  const staging = await fs.mkdtemp(join(root, '.minimal-')), stagedDir = join(staging, 'release'), staged = { node: { path: join(stagedDir, 'cua_node') }, cli: { path: join(stagedDir, BASE.cli) }, cu: { path: join(stagedDir, 'home/computer-use', APP) } } as Selection
  try {
    let resources = fullResources
    if (missing.length && !resources) {
      const archive = join(staging, 'minimal.zip')
      try { await d.downloadMinimalZip(s, m, archive, missing, { signal: options.signal, log: options.log }) } catch (e) { if (e instanceof RangeUnsupportedError) { options.signal?.throwIfAborted(); return } throw e }
      const extracted = join(staging, 'extracted'); await fs.mkdir(extracted); await d.unpack(archive, extracted, options.signal); resources = join(extracted, 'ChatGPT.app/Contents/Resources')
    }
    for (const g of GROUPS) {
      const o = selected[g]
      // Hybrid selections always own CU home: permitted external CU is input-only, never the runtime home.
      if (o && o.path !== current[g].path && g !== 'cu') { await signed(m, g, o, s, d, options.signal); continue }
      await fs.mkdir(dirname(staged[g].path), { recursive: true, mode: 0o700 })
      const from = o ?? { path: join(resources!, BASE[g]) }
      await signed(m, g, from, s, d, options.signal)
      if (g === 'node') { await fs.mkdir(join(staged.node.path, 'bin'), { recursive: true, mode: 0o755 }); for (const n of ['bin/node', 'LICENSE']) await d.copy(join(from.path, n), join(staged.node.path, n), options.signal) }
      else await d.copy(from.path, staged[g].path, options.signal)
      await signed(m, g, staged[g], s, d, options.signal); selected[g] = current[g]
    }
    await fs.mkdir(stagedDir, { recursive: true, mode: 0o700 })
    const ready: MinimalReady = { layout: 'minimal-v1', id: s.id, sourceSha256: s.sha256, sourceBytes: s.bytes, appVersion: s.appVersion, manifestDigest: digest(JSON.stringify(m)), components: selected }
    await fs.writeFile(join(stagedDir, 'minimal-ready.json'), JSON.stringify(ready), { flag: 'wx', mode: 0o600 })
    options.signal?.throwIfAborted(); await fs.mkdir(join(root, 'versions'), { recursive: true, mode: 0o700 }); canonical(root); canonical(join(root, 'versions'))
    const target = join(root, 'versions', s.id), backup = join(root, '.previous-minimal-' + randomUUID()); let backed = false
    if (existsSync(target)) canonical(target)
    try { if (existsSync(target)) { await fs.rename(target, backup); backed = true } await fs.rename(stagedDir, target) } catch (e) { if (backed) await fs.rename(backup, target); throw e }
    if (backed) await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
    return runtime(root, s, selected)
  } finally { await fs.rm(staging, { recursive: true, force: true }) }
}
function entriesFor(m: RangeManifest, gs: ComponentId[]) { return m.entries.filter(e => gs.includes(e.component)) }
