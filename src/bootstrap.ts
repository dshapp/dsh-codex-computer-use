import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, lstatSync, readFileSync, realpathSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { inflateRawSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'

export interface RuntimePaths { root: string; releaseDir: string; nodePath: string; cliPath: string; appPath: string; codexHome: string; clientPath: string; provenance?: { kind: 'local'; sourceApp: string } }
/** Default prefers a verified installed cohort. skipLocal bypasses all local paths/markers; force refreshes the official managed runtime (archivePath, if supplied, is still verified). */
export interface RuntimeOptions { runtimeDir?: string; archivePath?: string; sourceApp?: string; skipLocal?: boolean; force?: boolean; signal?: AbortSignal; log?: (message: string) => void }
export interface RuntimeSource { id: string; appVersion: string; platform: string; arch: string; url: string; sha256: string; bytes: number; teamIdentifier: string; layoutVersion: number }
interface Ready { id: string; appVersion: string; sha256: string; layoutVersion: number; hashes: Record<string, string> }
const require = createRequire(import.meta.url)
const APP = 'Codex Computer Use.app'
const CLIENT = 'Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'
const execute = promisify(execFile)
const MAX_EXPANDED = 12 * 1024 ** 3
function sourceFile(): RuntimeSource { return require('../runtime-source.json') as RuntimeSource }
function abort(signal?: AbortSignal) { signal?.throwIfAborted() }
function inside(root: string, path: string) { const r = relative(root, path); return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)) }
function safeChild(root: string, path: string) { if (!inside(root, path) || root === path) throw Error('Unsafe runtime cache path'); return path }
function noSymlink(path: string) {
  try { if (lstatSync(path).isSymbolicLink()) throw Error('Runtime cache path must not be a symlink: ' + path) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
}
function validateSource(s: RuntimeSource) {
  const u = new URL(s.url)
  if (s.id === '.' || s.id === '..' || !/^[a-zA-Z0-9._-]+$/.test(s.id) || !/^[a-f0-9]{64}$/i.test(s.sha256) || !Number.isSafeInteger(s.bytes) || s.bytes <= 0 || s.bytes > 2 * 1024 ** 3 || u.protocol !== 'https:' || u.username || u.password || u.hostname !== 'persistent.oaistatic.com' || !u.pathname.startsWith('/codex-app-prod/') || s.layoutVersion !== 1) throw Error('Invalid pinned runtime-source manifest')
}
export function resolveRuntimeRoot(runtimeDir?: string): string {
  const configured = runtimeDir || process.env.DSH_CODEX_CU_RUNTIME_DIR
  if (configured && !isAbsolute(configured)) throw Error('Runtime directory must be an absolute path')
  const raw = resolve(configured || join(homedir(), 'Library/Caches/dsh-codex-computer-use/runtime')); noSymlink(raw)
  if (dirname(raw) === raw) throw Error('Runtime directory cannot be the filesystem root')
  let parent = dirname(raw); const suffix = [relative(parent, raw)]
  while (!existsSync(parent)) { suffix.unshift(relative(dirname(parent), parent)); parent = dirname(parent) }
  const canonical = join(realpathSync(parent), ...suffix)
  if (canonical === realpathSync(homedir())) throw Error('Runtime directory cannot be the user home directory')
  return canonical
}
function paths(root: string, s: RuntimeSource): RuntimePaths {
  const releaseDir = join(root, 'versions', s.id), codexHome = join(releaseDir, 'home'), appPath = join(codexHome, 'computer-use', APP)
  return { root, releaseDir, nodePath: join(releaseDir, 'cua_node/bin/node'), cliPath: join(releaseDir, 'codex-cli/CodexCLI.app/Contents/MacOS/codex'), codexHome, appPath, clientPath: join(appPath, CLIENT) }
}
function required(p: RuntimePaths) { return [p.nodePath, p.cliPath, p.clientPath, join(p.appPath, 'Contents/MacOS/SkyComputerUseService'), join(p.releaseDir, 'cua_node/bin/node_repl'), join(p.releaseDir, 'cua_node/lib/node_modules/@oai/sky/package.json')] }
function marker(p: RuntimePaths, s: RuntimeSource): Ready | undefined {
  try {
    noSymlink(p.root); noSymlink(join(p.root, 'versions')); noSymlink(p.releaseDir); noSymlink(join(p.releaseDir, 'ready.json'))
    const m = JSON.parse(readFileSync(join(p.releaseDir, 'ready.json'), 'utf8')) as Ready
    if (m.id !== s.id || m.sha256 !== s.sha256 || m.appVersion !== s.appVersion || m.layoutVersion !== s.layoutVersion || !m.hashes || typeof m.hashes !== 'object') return
    for (const file of required(p)) { if (!lstatSync(file).isFile() || !inside(p.releaseDir, realpathSync(file)) || !/^[a-f0-9]{64}$/.test(m.hashes[relative(p.releaseDir, file)] ?? '')) return }
    return m
  } catch { return }
}
export function readPreparedRuntime(runtimeDir?: string): RuntimePaths | undefined { return production.readPreparedRuntime(runtimeDir) }
async function hashFile(file: string, signal?: AbortSignal): Promise<string> { abort(signal); const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) { abort(signal); hash.update(chunk as Buffer) } return hash.digest('hex') }
async function verifySigned(path: string, team: string, signal?: AbortSignal) {
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', '=anchor apple generic and certificate leaf[subject.OU] = "' + team + '"', '--verbose=2', path], { signal })
  const r = await execute('/usr/bin/codesign', ['-dv', '--verbose=4', path], { signal })
  const details = (r.stdout + r.stderr).split('\n')
  if (!details.includes('TeamIdentifier=' + team)) throw Error('OpenAI signing team mismatch: ' + path)
  const identifier = /\/(ChatGPT|Codex)\.app$/.test(path) ? 'com.openai.codex' : path.endsWith('/CodexCLI.app') ? 'codex' : path.endsWith('/' + APP) ? 'com.openai.sky.CUAService' : path.endsWith('/node') ? 'node' : undefined
  if (identifier && !details.includes('Identifier=' + identifier)) throw Error('Pinned runtime signing identifier mismatch: ' + path)
}
async function appVersion(app: string, signal?: AbortSignal) { const r = await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')], { signal }); return r.stdout.trim() }
async function availableBytes(root: string) { const stat = await fs.statfs(root); return Number(stat.bavail) * Number(stat.bsize) }

/** Inspect ZIP central directory and symlink payloads before invoking ditto. No archive code runs. */
export async function inspectRuntimeZip(file: string, signal?: AbortSignal): Promise<number> {
  const handle = await fs.open(file, 'r')
  try {
    const size = (await handle.stat()).size, tail = Buffer.alloc(Math.min(size, 65557)); await handle.read(tail, 0, tail.length, size - tail.length)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break }
    if (eocd < 0) throw Error('Invalid runtime ZIP end record')
    const entries = tail.readUInt16LE(eocd + 10), length = tail.readUInt32LE(eocd + 12), offset = tail.readUInt32LE(eocd + 16)
    if (tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6) || entries === 65535 || length > 64 * 1024 ** 2 || offset + length > size) throw Error('Unsupported multi-disk/ZIP64 runtime archive')
    const central = Buffer.alloc(length); await handle.read(central, 0, length, offset)
    const names = new Map<string, boolean>(); let cursor = 0, expanded = 0
    for (let i = 0; i < entries; i++) {
      abort(signal)
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) throw Error('Invalid runtime ZIP directory')
      const flags = central.readUInt16LE(cursor + 8), method = central.readUInt16LE(cursor + 10), packed = central.readUInt32LE(cursor + 20), unpacked = central.readUInt32LE(cursor + 24), n = central.readUInt16LE(cursor + 28), extra = central.readUInt16LE(cursor + 30), comment = central.readUInt16LE(cursor + 32), mode = central.readUInt32LE(cursor + 38) >>> 16, local = central.readUInt32LE(cursor + 42)
      if (cursor + 46 + n + extra + comment > central.length || flags & 1 || packed === 0xffffffff || unpacked === 0xffffffff || local === 0xffffffff) throw Error('Unsupported runtime ZIP entry')
      const name = central.subarray(cursor + 46, cursor + 46 + n).toString('utf8'), clean = name.replace(/\/$/, '')
      if (!clean || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some(p => p === '..' || p === '.') || names.has(clean)) throw Error('Unsafe runtime ZIP path: ' + name)
      const localHeader = Buffer.alloc(30); await handle.read(localHeader, 0, 30, local)
      if (localHeader.readUInt32LE(0) !== 0x04034b50 || localHeader.readUInt16LE(8) !== method || localHeader.readUInt16LE(6) !== flags) throw Error('Mismatched local ZIP header')
      const localName = Buffer.alloc(localHeader.readUInt16LE(26)); await handle.read(localName, 0, localName.length, local + 30)
      if (!localName.equals(central.subarray(cursor + 46, cursor + 46 + n))) throw Error('Mismatched local ZIP path')
      const kind = mode & 0xf000, link = kind === 0xa000
      if (kind && kind !== 0x8000 && kind !== 0x4000 && !link) throw Error('Special file in runtime ZIP')
      names.set(clean, link); expanded += unpacked
      if (expanded > MAX_EXPANDED) throw Error('Runtime ZIP exceeds expanded size limit')
      if (link) {
        if (unpacked > 4096 || packed > 65536 || (method !== 0 && method !== 8)) throw Error('Invalid runtime ZIP symlink')
        const header = Buffer.alloc(30); await handle.read(header, 0, 30, local)
        if (header.readUInt32LE(0) !== 0x04034b50) throw Error('Invalid local ZIP header')
        const dataOffset = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), data = Buffer.alloc(packed)
        if (dataOffset + packed > offset) throw Error('Invalid ZIP symlink data')
        await handle.read(data, 0, packed, dataOffset)
        const target = (method === 8 ? inflateRawSync(data, { maxOutputLength: 4096 }) : data).toString('utf8')
        const destination = posix.normalize(posix.join(posix.dirname(clean), target))
        if (!target || target.includes('\0') || target.includes('\\') || posix.isAbsolute(target) || /^[A-Za-z]:/.test(target) || destination === '..' || destination.startsWith('../')) throw Error('Escaping runtime ZIP symlink: ' + name)
      }
      cursor += 46 + n + extra + comment
    }
    if (cursor !== central.length) throw Error('Unexpected runtime ZIP directory data')
    for (const name of names.keys()) { let parent = posix.dirname(name); while (parent !== '.') { if (names.get(parent)) throw Error('ZIP entry traverses a symlink: ' + name); parent = posix.dirname(parent) } }
    return expanded
  } finally { await handle.close() }
}
async function download(s: RuntimeSource, file: string, signal?: AbortSignal, log?: (message: string) => void) {
  const timeout = AbortSignal.timeout(15 * 60 * 1000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let url = new URL(s.url), response: Response | undefined
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== 'https:' || url.hostname !== new URL(s.url).hostname || url.username || url.password || url.pathname !== new URL(s.url).pathname || url.search) throw Error('Runtime download redirect is outside pinned official URL')
    response = await fetch(url, { redirect: 'manual', signal: combined })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location'); await response.body?.cancel(); if (!location || redirects === 5) throw Error('Invalid runtime download redirect'); url = new URL(location, url)
  }
  if (!response?.ok || !response.body) throw Error('Official runtime download failed: HTTP ' + response?.status)
  const length = response.headers.get('content-length'), type = response.headers.get('content-type') ?? ''
  if ((length && Number(length) !== s.bytes) || /text\/|json|html/i.test(type)) { await response.body.cancel(); throw Error('Official runtime download has unexpected size/content type') }
  const hash = createHash('sha256'); let bytes = 0, last = 0
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; if (bytes > s.bytes) return callback(Error('Official runtime download exceeds pinned size')); hash.update(chunk); if (bytes - last > 32 * 1024 ** 2) { last = bytes; log?.('Downloading official runtime: ' + Math.round(bytes / s.bytes * 100) + '%') } callback(null, chunk) } })
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: combined })
  if (bytes !== s.bytes || hash.digest('hex') !== s.sha256) throw Error('Official runtime ZIP SHA256/size mismatch')
}
interface Dependencies {
  localCandidates: () => string[]; localHomes: () => string[];
  platform: string; arch: string; download: typeof download; inspectZip: typeof inspectRuntimeZip; verifySigned: typeof verifySigned; appVersion: typeof appVersion; availableBytes: typeof availableBytes;
  copy: (source: string, destination: string, signal?: AbortSignal) => Promise<void>; unpack: (archive: string, destination: string, signal?: AbortSignal) => Promise<void>; lockWaitMs: number; lockPollMs: number
  lockFs?: Pick<typeof fs, 'mkdir' | 'writeFile' | 'rename' | 'rm'> // Internal test seam for deterministic lock/guard races.
}
const defaultDeps: Dependencies = { localCandidates: () => ['/Applications/ChatGPT.app', '/Applications/Codex.app', join(homedir(), 'Applications/ChatGPT.app'), join(homedir(), 'Applications/Codex.app')], localHomes: () => [...new Set([...(process.env.CODEX_HOME && isAbsolute(process.env.CODEX_HOME) ? [resolve(process.env.CODEX_HOME)] : []), join(homedir(), '.codex')])], platform: process.platform, arch: process.arch, download, inspectZip: inspectRuntimeZip, verifySigned, appVersion, availableBytes, copy: executeCopy, unpack: async (a, d, signal) => { await execute('/usr/bin/ditto', ['-x', '-k', a, d], { signal }) }, lockWaitMs: 20 * 60 * 1000, lockPollMs: 250 }
interface LockOwner { pid: number; token: string; startTime: number }
function deadOwner(owner: LockOwner) {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') return false
  try { process.kill(owner.pid, 0); return false } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' }
}
async function reclaimLock(root: string, directory: string, io: NonNullable<Dependencies['lockFs']>): Promise<boolean> {
  // Serialize reclaimers inside the stale inode; a contender can never rename a new live owner's lock.
  const guard = join(directory, '.reclaim'), guardToken = randomUUID()
  try { await io.mkdir(guard, { mode: 0o700 }); await io.writeFile(join(guard, 'owner.json'), JSON.stringify({ pid: process.pid, token: guardToken, startTime: Date.now() }), { mode: 0o600 }) }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      // A crashed reclaimer must not leave its parent lock permanently unrecoverable.
      try { const owner = JSON.parse(await fs.readFile(join(guard, 'owner.json'), 'utf8')) as LockOwner; if (deadOwner(owner)) { const first = await fs.stat(guard), check = await fs.stat(guard); if (first.ino === check.ino) await fs.rm(guard, { recursive: true }) } } catch {}
    }
    return false
  }
  let renamed = false
  try {
    noSymlink(directory); const identity = await fs.stat(directory)
    let owner: LockOwner | undefined
    try { owner = JSON.parse(await fs.readFile(join(directory, 'owner.json'), 'utf8')) as LockOwner } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false }
    if (owner ? !deadOwner(owner) : Date.now() - identity.birthtimeMs < 60000) return false
    if (owner) { const check = JSON.parse(await fs.readFile(join(directory, 'owner.json'), 'utf8')) as LockOwner; if (check.token !== owner.token || !deadOwner(check)) return false }
    const check = await fs.stat(directory); if (check.ino !== identity.ino || check.dev !== identity.dev) return false
    const tomb = join(root, '.stale-lock-' + randomUUID()); await fs.rename(directory, tomb); renamed = true
    await fs.rm(safeChild(root, tomb), { recursive: true, force: true }); return true
  } finally {
    if (!renamed) { try { const owner = JSON.parse(await fs.readFile(join(guard, 'owner.json'), 'utf8')) as LockOwner; if (owner.token === guardToken) await fs.rm(guard, { recursive: true, force: true }) } catch {} }
  }
}
async function lock(root: string, d: Dependencies, signal?: AbortSignal): Promise<() => Promise<void>> {
  const directory = join(root, '.install-lock'), token = randomUUID(), started = Date.now(), io = d.lockFs ?? fs
  while (true) {
    abort(signal); noSymlink(directory)
    let acquired = false
    try { await fs.mkdir(directory, { mode: 0o700 }); acquired = true; await fs.writeFile(join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, token, startTime: Date.now() } satisfies LockOwner), { flag: 'wx', mode: 0o600 }); break }
    catch (e) {
      if (acquired) { await fs.rm(safeChild(root, directory), { recursive: true, force: true }); throw e }
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      if (await reclaimLock(root, directory, io).catch(() => false)) continue
      if (Date.now() - started > d.lockWaitMs) throw Error('Timed out waiting for runtime installation lock; retry setup')
      await delay(d.lockPollMs, undefined, { signal })
    }
  }
  return async () => {
    noSymlink(directory)
    const owner = JSON.parse(await fs.readFile(join(directory, 'owner.json'), 'utf8')) as LockOwner
    if (owner.token !== token) return
    // Stop exposing this inode at the acquisition path before recursive cleanup.
    // Live contenders may be adding/removing .reclaim there; deleting the public
    // path can fail with ENOTEMPTY or descend into a replacement owner's lock.
    const tomb = safeChild(root, join(root, '.released-lock-' + randomUUID()))
    await io.rename(safeChild(root, directory), tomb)
    await io.rm(tomb, { recursive: true, force: true })
  }
}
async function containedTree(root: string, current = root): Promise<void> {
  for (const e of await fs.readdir(current, { withFileTypes: true })) {
    const path = join(current, e.name), stat = await fs.lstat(path)
    if (stat.isSymbolicLink()) { if (!inside(root, await fs.realpath(path))) throw Error('Runtime layout has escaping symlink: ' + path) }
    else if (stat.isDirectory()) await containedTree(root, path)
    else if (!stat.isFile()) throw Error('Runtime layout has special file: ' + path)
  }
}
async function layout(p: RuntimePaths) { for (const file of required(p)) { const stat = await fs.lstat(file); if (!stat.isFile() || !inside(p.releaseDir, await fs.realpath(file)) || (!file.endsWith('.json') && !(stat.mode & 0o111))) throw Error('Missing/unsafe runtime binary: ' + file) } }
async function signedRuntime(p: RuntimePaths, s: RuntimeSource, d: Dependencies, signal?: AbortSignal) { await layout(p); for (const target of [p.nodePath, join(p.releaseDir, 'codex-cli/CodexCLI.app'), p.appPath]) { abort(signal); await d.verifySigned(target, s.teamIdentifier, signal) } }
async function cacheValid(p: RuntimePaths, s: RuntimeSource, d: Dependencies, signal?: AbortSignal) {
  const m = marker(p, s); if (!m) return false
  try { await signedRuntime(p, s, d, signal); for (const file of required(p)) if (await hashFile(file, signal) !== m.hashes[relative(p.releaseDir, file)]) return false; return true } catch (e) { abort(signal); return false }
}
interface LocalReady extends Ready { sourceApp: string; codexHome: string; hashes: Record<string, string> }
const LOCAL_READY = 'local-ready.json'
function ownedLocalHome(root: string, s: RuntimeSource) { return join(root, 'local', s.id, 'home') }
function bundledCU(app: string) { return join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/sky', APP) }
function localPaths(root: string, sourceApp: string, codexHome: string): RuntimePaths {
  const releaseDir = join(sourceApp, 'Contents/Resources'), appPath = join(codexHome, 'computer-use', APP)
  return { root, releaseDir, nodePath: join(releaseDir, 'cua_node/bin/node'), cliPath: join(releaseDir, 'codex-cli/CodexCLI.app/Contents/MacOS/codex'), appPath, codexHome, clientPath: join(appPath, CLIENT), provenance: { kind: 'local', sourceApp } }
}
function localLayout(p: RuntimePaths) {
  const sourceApp = p.provenance!.sourceApp
  if (!isAbsolute(sourceApp) || !/\/(ChatGPT|Codex)\.app$/.test(sourceApp) || realpathSync(sourceApp) !== sourceApp) throw Error('Unsafe local source app path')
  if (!isAbsolute(p.codexHome) || realpathSync(p.codexHome) !== p.codexHome || realpathSync(p.appPath) !== p.appPath) throw Error('Unsafe canonical CU home/app path')
  for (const file of required(p)) {
    const stat = lstatSync(file), boundary = inside(p.appPath, file) ? p.appPath : sourceApp
    if (!stat.isFile() || !inside(boundary, realpathSync(file)) || (!file.endsWith('.json') && !(stat.mode & 0o111))) throw Error('Missing/unsafe local runtime binary: ' + file)
  }
}
// Only runtime/bundle metadata is read. Never inspect CODEX_HOME auth/config/session data.
function localFiles(p: RuntimePaths) {
  const sourceApp = p.provenance!.sourceApp, bundled = bundledCU(sourceApp)
  const files = new Set([...required(p), join(bundled, CLIENT), join(bundled, 'Contents/MacOS/SkyComputerUseService')])
  const executableDir = join(sourceApp, 'Contents/MacOS')
  for (const name of readdirSync(executableDir)) { const file = join(executableDir, name); if (lstatSync(file).isFile()) files.add(file) }
  for (const app of [sourceApp, join(p.releaseDir, 'codex-cli/CodexCLI.app'), bundled, p.appPath, join(bundled, 'Contents/SharedSupport/SkyComputerUseClient.app'), join(p.appPath, 'Contents/SharedSupport/SkyComputerUseClient.app')]) {
    for (const name of ['Contents/Info.plist', 'Contents/_CodeSignature/CodeResources']) { const file = join(app, name); if (existsSync(file)) files.add(file) }
  }
  return [...files]
}
function hashFileSync(file: string) {
  const handle = openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024)
  try { let bytes: number; while ((bytes = readSync(handle, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes)); return hash.digest('hex') }
  finally { closeSync(handle) }
}
function localMarker(root: string, s: RuntimeSource, d: Dependencies): RuntimePaths | undefined {
  try {
    noSymlink(root); const file = join(root, LOCAL_READY); noSymlink(file)
    const m = JSON.parse(readFileSync(file, 'utf8')) as LocalReady
    if (m.id !== s.id || m.sha256 !== s.sha256 || m.appVersion !== s.appVersion || m.layoutVersion !== s.layoutVersion || typeof m.sourceApp !== 'string' || typeof m.codexHome !== 'string' || !m.hashes) return
    // Marker paths must be related to the verified source Resources and a permitted canonical home.
    if (![...d.localHomes(), ownedLocalHome(root, s)].includes(m.codexHome)) return
    const p = localPaths(root, m.sourceApp, m.codexHome); localLayout(p)
    const files = localFiles(p)
    for (const target of files) {
      const boundary = inside(p.appPath, target) ? p.appPath : m.sourceApp
      if (!lstatSync(target).isFile() || !inside(boundary, realpathSync(target)) || !/^[a-f0-9]{64}$/.test(m.hashes[target] ?? '') || hashFileSync(target) !== m.hashes[target]) return
    }
    // Deleted seals must invalidate the marker too, not silently disappear from localFiles().
    if (Object.keys(m.hashes).length !== files.length) return
    return p
  } catch { return }
}
async function publishLocal(p: RuntimePaths, s: RuntimeSource, signal?: AbortSignal) {
  localLayout(p)
  const hashes: Record<string, string> = {}; for (const file of localFiles(p)) hashes[file] = await hashFile(file, signal)
  const file = join(p.root, LOCAL_READY), temporary = join(p.root, '.local-ready-' + randomUUID())
  noSymlink(file)
  try { await fs.writeFile(temporary, JSON.stringify({ id: s.id, appVersion: s.appVersion, sha256: s.sha256, layoutVersion: s.layoutVersion, sourceApp: p.provenance!.sourceApp, codexHome: p.codexHome, hashes } satisfies LocalReady), { flag: 'wx', mode: 0o600 }); abort(signal); await fs.rename(temporary, file) }
  finally { await fs.rm(temporary, { force: true }) }
}
async function verifyLocalSource(root: string, app: string, s: RuntimeSource, d: Dependencies, signal?: AbortSignal) {
  if (await d.appVersion(app, signal) !== s.appVersion) throw Error('installed version is not the verified cohort ' + s.appVersion)
  await d.verifySigned(app, s.teamIdentifier, signal)
  const resources = join(app, 'Contents/Resources'), bundled = bundledCU(app)
  // The whole signed source app binds node/CLI/CU to this exact, explicitly verified cohort.
  await containedTree(join(resources, 'cua_node')); await containedTree(join(resources, 'codex-cli'))
  const p = localPaths(root, app, ownedLocalHome(root, s))
  for (const file of [...required(p).filter(f => !inside(p.appPath, f)), join(bundled, CLIENT), join(bundled, 'Contents/MacOS/SkyComputerUseService')]) {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || !inside(app, await fs.realpath(file)) || (!file.endsWith('.json') && !(stat.mode & 0o111))) throw Error('missing/unsafe local component: ' + file)
  }
  for (const target of [p.nodePath, join(resources, 'codex-cli/CodexCLI.app'), bundled]) await d.verifySigned(target, s.teamIdentifier, signal)
}
async function matchingCU(p: RuntimePaths, s: RuntimeSource, d: Dependencies, signal?: AbortSignal) {
  localLayout(p); await containedTree(p.appPath); await d.verifySigned(p.appPath, s.teamIdentifier, signal)
  for (const name of [CLIENT, 'Contents/MacOS/SkyComputerUseService']) if (await hashFile(join(p.appPath, name), signal) !== await hashFile(join(bundledCU(p.provenance!.sourceApp), name), signal)) throw Error('canonical CU nativeclient/service hash does not match installed cohort')
}
async function selectLocal(root: string, s: RuntimeSource, d: Dependencies, options: RuntimeOptions): Promise<RuntimePaths | undefined> {
  // force explicitly refreshes the official managed runtime; archivePath also explicitly selects it.
  if (options.skipLocal || options.force || options.archivePath) return
  const candidates = options.sourceApp ? [resolve(options.sourceApp)] : d.localCandidates()
  for (const candidate of candidates) {
    if (!existsSync(candidate)) { if (options.sourceApp) throw Error('Explicit source app not found: ' + candidate); continue }
    let app: string
    try { app = realpathSync(candidate); await verifyLocalSource(root, app, s, d, options.signal) }
    catch (e) { abort(options.signal); options.log?.('Installed app incompatible/incomplete: ' + candidate + ': ' + (e instanceof Error ? e.message : String(e))); if (options.sourceApp) throw e; continue }
    const homes = [...new Set([...d.localHomes(), ownedLocalHome(root, s)])]
    for (const home of homes) {
      const p = localPaths(root, app, home)
      if (!existsSync(p.appPath)) continue
      try { await matchingCU(p, s, d, options.signal); await publishLocal(p, s, options.signal); options.log?.('Directly reusing verified installed node/CLI and canonical CU: ' + app); return p }
      catch (e) { abort(options.signal); options.log?.('Canonical CU incompatible: ' + p.appPath + ': ' + (e instanceof Error ? e.message : String(e))) }
    }
    // A complete source needs no network: copy only CU into an owned canonical home, never node/CLI.
    const home = ownedLocalHome(root, s), p = localPaths(root, app, home)
    for (const path of [join(root, 'local'), join(root, 'local', s.id), home, dirname(p.appPath), p.appPath]) noSymlink(path)
    await fs.mkdir(dirname(p.appPath), { recursive: true, mode: 0o700 })
    const staging = await fs.mkdtemp(join(root, '.local-cu-')), stagedApp = join(staging, APP)
    const backup = join(staging, 'previous.app'); let backedUp = false
    try {
      await d.copy(bundledCU(app), stagedApp, options.signal)
      await containedTree(stagedApp); await d.verifySigned(stagedApp, s.teamIdentifier, options.signal)
      for (const name of [CLIENT, 'Contents/MacOS/SkyComputerUseService']) if (await hashFile(join(stagedApp, name), options.signal) !== await hashFile(join(bundledCU(app), name), options.signal)) throw Error('Copied CU hash mismatch')
      abort(options.signal)
      if (existsSync(p.appPath)) { await fs.rename(p.appPath, backup); backedUp = true }
      try { await fs.rename(stagedApp, p.appPath) } catch (e) { if (backedUp) await fs.rename(backup, p.appPath); throw e }
      await matchingCU(p, s, d, options.signal); await publishLocal(p, s, options.signal)
      options.log?.('Directly reusing installed node/CLI; copied only bundled CU to owned canonical home'); return p
    } finally { await fs.rm(safeChild(root, staging), { recursive: true, force: true }) }
  }
}

/** Internal dependency injection: never used by CLI/environment; tests cannot accidentally launch CU. */
export function createBootstrapForTesting(s: RuntimeSource, overrides: Partial<Dependencies> = {}) { return createBootstrap(() => s, { ...defaultDeps, ...overrides }) }
function createBootstrap(getSource: () => RuntimeSource, d: Dependencies) {
  const flights = new Map<string, Promise<RuntimePaths>>()
  const ensure = (options: RuntimeOptions = {}): Promise<RuntimePaths> => {
    let root: string
    try { root = resolveRuntimeRoot(options.runtimeDir) } catch (e) { return Promise.reject(e) }
    const key = JSON.stringify([root, !!options.skipLocal, !!options.force, options.sourceApp ?? '', options.archivePath ?? ''])
    const current = flights.get(key); if (current) return current.then(p => { abort(options.signal); return p })
    const task = prepare(root, options).finally(() => { if (flights.get(key) === task) flights.delete(key) }); flights.set(key, task); return task
  }
  async function prepare(root: string, options: RuntimeOptions): Promise<RuntimePaths> {
    const s = getSource(); validateSource(s); abort(options.signal)
    if (d.platform !== s.platform || d.arch !== s.arch) throw Error('Official Codex CU runtime supports ' + s.platform + '/' + s.arch + ' only; unsupported platform ' + d.platform + '/' + d.arch)
    noSymlink(root); await fs.mkdir(root, { recursive: true, mode: 0o700 }); await fs.chmod(root, 0o700); noSymlink(root)
    const p = paths(root, s); noSymlink(join(root, 'versions')); noSymlink(p.releaseDir)
    const releaseLock = await lock(root, d, options.signal); let staging: string | undefined
    try {
      const local = await selectLocal(root, s, d, options); if (local) return local
      // A managed selection must not leave an older local marker shadowing its result in sync readers.
      // rm without recursive never follows a marker symlink; skipLocal must not inspect its contents.
      await fs.rm(join(root, LOCAL_READY), { force: true })
      if (!options.force && await cacheValid(p, s, d, options.signal)) { options.log?.('Using verified cached official Codex CU runtime'); return p }
      options.log?.('Preparing pinned official Codex CU runtime ' + s.appVersion)
      // Budget includes ZIP, extracted app, copied runtime and temporary previous release.
      if (await d.availableBytes(root) < s.bytes * 8) throw Error('Insufficient disk space for official runtime setup; free at least ' + Math.ceil(s.bytes * 8 / 1024 ** 3) + ' GiB and retry')
      staging = await fs.mkdtemp(join(root, '.prepare-')); const staged = paths(staging, s)
      let app: string | undefined
      if (!app) {
        const archive = options.archivePath ? resolve(options.archivePath) : join(staging, 'official.zip')
        if (!options.archivePath) await d.download(s, archive, options.signal, options.log)
        if ((await fs.stat(archive)).size !== s.bytes || await hashFile(archive, options.signal) !== s.sha256) throw Error('Pinned official runtime ZIP SHA256/size mismatch; retry with the exact official source')
        const expanded = await d.inspectZip(archive, options.signal)
        if (expanded > MAX_EXPANDED || await d.availableBytes(root) < expanded * 2 + s.bytes) throw Error('Insufficient disk space for expanded official runtime')
        const extracted = join(staging, 'extracted'); await fs.mkdir(extracted); await d.unpack(archive, extracted, options.signal)
        await containedTree(extracted)
        const apps = (await fs.readdir(extracted)).filter(name => name === 'ChatGPT.app' || name === 'Codex.app')
        if (apps.length !== 1) throw Error('Official ZIP is missing a unique root app')
        app = join(extracted, apps[0]!); if (await d.appVersion(app, options.signal) !== s.appVersion) throw Error('Official ZIP app version mismatch'); await d.verifySigned(app, s.teamIdentifier, options.signal)
      }
      abort(options.signal)
      const resources = join(app, 'Contents/Resources')
      for (const name of ['cua_node', 'codex-cli']) { const source = join(resources, name); if (!(await fs.lstat(source)).isDirectory()) throw Error('Official app is missing runtime layout: ' + name); await containedTree(source); await fs.mkdir(dirname(join(staged.releaseDir, name)), { recursive: true, mode: 0o700 }); await d.copy(source, join(staged.releaseDir, name), options.signal) }
      const cua = join(staged.releaseDir, 'cua_node/lib/node_modules/@oai/sky', APP)
      await fs.mkdir(dirname(staged.appPath), { recursive: true, mode: 0o700 }); await d.copy(cua, staged.appPath, options.signal)
      await signedRuntime(staged, s, d, options.signal)
      const hashes: Record<string, string> = {}; for (const file of required(staged)) hashes[relative(staged.releaseDir, file)] = await hashFile(file, options.signal)
      await fs.writeFile(join(staged.releaseDir, 'ready.json'), JSON.stringify({ id: s.id, appVersion: s.appVersion, sha256: s.sha256, layoutVersion: s.layoutVersion, hashes } satisfies Ready), { flag: 'wx', mode: 0o600 })
      abort(options.signal); noSymlink(root); noSymlink(join(root, 'versions')); noSymlink(p.releaseDir); await fs.mkdir(join(root, 'versions'), { recursive: true, mode: 0o700 })
      const backup = join(root, '.previous-' + randomUUID()); let backedUp = false
      try { if (existsSync(p.releaseDir)) { await fs.rename(p.releaseDir, backup); backedUp = true } await fs.rename(staged.releaseDir, p.releaseDir) }
      catch (e) { if (backedUp) await fs.rename(backup, p.releaseDir); throw e }
      if (backedUp) await fs.rm(safeChild(root, backup), { recursive: true, force: true }).catch(() => {})
      options.log?.('Official signed Codex CU runtime is ready'); return p
    } catch (e) { abort(options.signal); throw new Error('Codex CU runtime setup failed. Retry setup after correcting the source, permissions or disk space: ' + (e instanceof Error ? e.message : String(e)), { cause: e }) }
    finally { try { if (staging) await fs.rm(safeChild(root, staging), { recursive: true, force: true }) } finally { await releaseLock() } }
  }
  return { ensureRuntime: ensure, readPreparedRuntime(runtimeDir?: string) { try { const s = getSource(); validateSource(s); const root = resolveRuntimeRoot(runtimeDir), local = localMarker(root, s, d); if (local) return local; const p = paths(root, s); return marker(p, s) ? p : undefined } catch { return undefined } } }
}
async function executeCopy(source: string, destination: string, signal?: AbortSignal) {
  abort(signal)
  // ditto preserves macOS extended attributes (including quarantine), bundle structure and modes.
  await execute('/usr/bin/ditto', [source, destination], { signal }); abort(signal)
}
const production = createBootstrap(sourceFile, defaultDeps)
export async function ensureRuntime(options?: RuntimeOptions): Promise<RuntimePaths> {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    const version = (await execute('/usr/bin/sw_vers', ['-productVersion'], { signal: options?.signal, timeout: 5000 })).stdout.trim().split('.').map(Number)
    if ((version[0] ?? 0) < 14 || (version[0] === 14 && (version[1] ?? 0) < 4)) throw Error('Codex CU requires macOS 14.4 or newer. Upgrade macOS before preparing this runtime.')
  }
  return production.ensureRuntime(options)
}
