import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export interface RangeSource { url: string; bytes: number; sha256: string }
export type ComponentId = 'node' | 'cli' | 'cu'
/** Entry hashes authenticate compressed payloads, pinned after maintainer signature verification. */
export interface RangeManifest {
  version: 1
  sourceSha256: string
  sourceBytes: number
  /** Exact central records, excluding the end-of-central-directory record. */
  centralDirectory: { offset: number; bytes: number; sha256: string }
  entries: Array<{ name: string; component: ComponentId; localOffset: number; compressedBytes: number; bytes: number; sha256: string; uncompressedSha256?: string; kind?: 'file' | 'symlink' | 'directory'; mode?: number }>
}
/** Only this error permits a caller to fall back to a separately verified full download. */
export class RangeUnsupportedError extends Error {
  constructor(message: string) { super(message); this.name = 'RangeUnsupportedError' }
}

const ZIP32 = 0xffffffff
const MAX_CHUNK = 128 * 1024 ** 2
const GAP = 64 * 1024
const MAX_CENTRAL = 64 * 1024 ** 2
const COMPONENTS = new Set<string>(['node', 'cli', 'cu'])
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const hashValid = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/i.test(s)
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0 && n < ZIP32
function check(ok: unknown, message: string): asserts ok { if (!ok) throw Error(message) }
function cancel(body: ReadableStream<Uint8Array> | null | undefined) { if (body) void body.cancel().catch(() => {}) }
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((yes, no) => {
    const abort = () => { cleanup(); no(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); yes(value) }, error => { cleanup(); no(error) })
  })
}
function decode(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw Error('Invalid UTF-8 ZIP path') }
}
function pathKey(name: string): string {
  check(typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.includes('\0') && !name.startsWith('/') && !/^[A-Za-z]:/.test(name), 'Unsafe ZIP path: ' + name)
  const clean = name.endsWith('/') ? name.slice(0, -1) : name
  check(clean.length > 0 && clean.split('/').every(p => p !== '' && p !== '.' && p !== '..'), 'Unsafe ZIP path: ' + name)
  // Extraction is on macOS: reject case-folded and Unicode-normalized collisions, too.
  return clean.normalize('NFC').toLowerCase()
}
function extras(data: Buffer, name: Buffer) {
  for (let at = 0; at < data.length;) {
    check(at + 4 <= data.length, 'Malformed ZIP extra')
    const id = data.readUInt16LE(at), length = data.readUInt16LE(at + 2)
    check(at + 4 + length <= data.length, 'Malformed ZIP extra')
    check(id !== 1, 'Unsupported ZIP64 extra')
    check(id !== 0x756e && !(id === 0x000d && length > 12), 'Unsupported ZIP extra symlink/path override')
    // Info-ZIP Unicode path fields must not override the authenticated name.
    if (id === 0x7075) {
      const value = data.subarray(at + 4, at + 4 + length)
      check(length >= 5 && value[0] === 1 && value.subarray(5).equals(name), 'ZIP extra path override')
    }
    at += 4 + length
  }
}
interface Entry {
  name: string; nameBytes: Buffer; key: string; raw: Buffer; flags: number; method: number
  packed: number; bytes: number; crc: number; local: number; bound: number; directory: boolean; link: boolean
}
function parseCentral(data: Buffer, offset: number): Entry[] {
  const entries: Entry[] = [], names = new Map<string, Entry>(), offsets = new Set<number>()
  let expanded = 0
  for (let at = 0; at < data.length;) {
    check(entries.length < 65534 && at + 46 <= data.length && data.readUInt32LE(at) === 0x02014b50, 'Invalid ZIP central directory/count (ZIP64 unsupported)')
    const n = data.readUInt16LE(at + 28), x = data.readUInt16LE(at + 30), c = data.readUInt16LE(at + 32), end = at + 46 + n + x + c
    check(n > 0 && end <= data.length, 'Invalid ZIP central bounds')
    const raw = data.subarray(at, end), flags = raw.readUInt16LE(8), method = raw.readUInt16LE(10)
    check(raw.readUInt16LE(6) <= 20 && raw.readUInt16LE(34) === 0, 'Unsupported ZIP64/multi-disk version')
    check((flags & ~0x080e) === 0 && (method === 0 || method === 8) && (method !== 0 || !(flags & 6)), 'Unsupported ZIP flags/encryption/method')
    const packed = raw.readUInt32LE(20), bytes = raw.readUInt32LE(24), local = raw.readUInt32LE(42)
    check(integer(packed) && integer(bytes) && integer(local), 'Unsupported ZIP64 sizes/offset')
    const nameBytes = raw.subarray(46, 46 + n), name = decode(nameBytes), key = pathKey(name)
    check((flags & 0x800) || nameBytes.every(b => b < 128), 'Unsupported non-UTF8 ZIP path')
    extras(raw.subarray(46 + n, 46 + n + x), nameBytes)
    const mode = raw.readUInt32LE(38) >>> 16, kind = mode & 0xf000, directory = name.endsWith('/'), link = kind === 0xa000
    check(kind === 0 || kind === 0x8000 || kind === 0x4000 || link, 'Special file in ZIP')
    check((kind !== 0x4000 || directory) && (!directory || kind === 0 || kind === 0x4000) && (!(raw.readUInt32LE(38) & 0x10) || directory), 'ZIP file/directory type mismatch')
    check(!directory || (packed === 0 && bytes === 0 && method === 0), 'Nonempty ZIP directory')
    check(method !== 0 || packed === bytes, 'Stored ZIP size mismatch')
    check(!link || (bytes > 0 && bytes <= 4096 && packed <= 8192), 'Oversized ZIP symlink')
    check(local + 30 + n + packed <= offset && !offsets.has(local), 'Invalid/overlapping ZIP local offset')
    check(!names.has(key), 'Duplicate/colliding ZIP path: ' + name)
    expanded += bytes; check(expanded <= 12 * 1024 ** 3, 'ZIP expanded size limit')
    const entry: Entry = { name, nameBytes, key, raw, flags, method, packed, bytes, crc: raw.readUInt32LE(16), local, bound: offset, directory, link }
    names.set(key, entry); offsets.add(local); entries.push(entry); at = end
  }
  check(entries.length > 0, 'Empty ZIP central directory')
  for (const entry of entries) {
    const parts = entry.key.split('/')
    for (let i = 1; i < parts.length; i++) {
      const parent = names.get(parts.slice(0, i).join('/'))
      check(!parent || parent.directory, parent?.link ? 'ZIP symlink parent traversal' : 'ZIP file parent collision')
    }
  }
  const sorted = [...entries].sort((a, b) => a.local - b.local)
  sorted.forEach((entry, i) => {
    entry.bound = sorted[i + 1]?.local ?? offset
    check(entry.local + 30 + entry.nameBytes.length + entry.packed <= entry.bound, 'Overlapping ZIP local entries')
  })
  return entries
}
function validate(source: RangeSource, manifest: RangeManifest, components: ComponentId[]) {
  const u = new URL(source.url)
  check(u.href === source.url && u.protocol === 'https:' && u.hostname === 'persistent.oaistatic.com' && !u.port && !u.username && !u.password && !source.url.includes('?') && !source.url.includes('#') && u.pathname.startsWith('/codex-app-prod/') && u.pathname.length > '/codex-app-prod/'.length, 'Invalid pinned official URL')
  const decoded = decodeURIComponent(u.pathname)
  check(!decoded.includes('\\') && !decoded.includes('\0') && !decoded.split('/').some(p => p === '.' || p === '..'), 'Invalid pinned official URL path')
  check(integer(source.bytes) && source.bytes >= 22 && hashValid(source.sha256), 'Invalid pinned source')
  check(manifest.version === 1 && manifest.sourceBytes === source.bytes && hashValid(manifest.sourceSha256) && manifest.sourceSha256.toLowerCase() === source.sha256.toLowerCase(), 'Range manifest source mismatch')
  const cd = manifest.centralDirectory
  check(cd && integer(cd.offset) && integer(cd.bytes) && cd.bytes > 0 && cd.bytes <= MAX_CENTRAL && cd.offset + cd.bytes + 22 <= source.bytes && source.bytes - cd.offset - cd.bytes <= 65557 && hashValid(cd.sha256), 'Invalid pinned central directory')
  check(Array.isArray(components) && components.length > 0 && components.every(c => COMPONENTS.has(c)) && new Set(components).size === components.length, 'Missing/unrecognized component selection')
  check(Array.isArray(manifest.entries) && manifest.entries.length > 0 && manifest.entries.length <= 65534, 'Invalid range manifest entries')
  const names = new Set<string>()
  for (const entry of manifest.entries) {
    const key = pathKey(entry.name)
    check(COMPONENTS.has(entry.component) && integer(entry.localOffset) && integer(entry.compressedBytes) && integer(entry.bytes) && hashValid(entry.sha256) && !names.has(key), 'Invalid/colliding range manifest entry')
    check(entry.uncompressedSha256 === undefined || hashValid(entry.uncompressedSha256), 'Invalid optional uncompressed SHA256')
    check(entry.kind === undefined || ['file', 'directory', 'symlink'].includes(entry.kind), 'Invalid optional ZIP kind')
    check(entry.mode === undefined || (Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777), 'Invalid optional ZIP mode')
    names.add(key)
  }
  check(components.every(c => manifest.entries.some(e => e.component === c)), 'Missing component in range manifest')
}
function symlink(entry: Entry, packed: Buffer) {
  const data = entry.method === 8 ? inflateRawSync(packed, { maxOutputLength: 4096 }) : packed
  check(data.length === entry.bytes && data.length <= 4096, 'ZIP symlink size mismatch')
  const target = decode(data)
  check(target.length > 0 && !target.includes('\0') && !target.includes('\\') && !target.startsWith('/') && !/^[A-Za-z]:/.test(target), 'Unsafe absolute ZIP symlink target')
  const joined = posix.normalize(posix.join(posix.dirname(entry.name), target))
  check(joined !== '..' && !joined.startsWith('../') && !posix.isAbsolute(joined), 'Escaping ZIP symlink target')
  return target
}
function validateLinkGraph(links: Map<string, string>) {
  for (const [name, target] of links) {
    const resolved = posix.dirname(name) === '.' ? [] : posix.dirname(name).split('/')
    const pending = target.split('/'); let hops = 0
    while (pending.length) {
      const part = pending.shift()!
      if (!part || part === '.') continue
      if (part === '..') { check(resolved.length > 0, 'Escaping ZIP symlink traversal'); resolved.pop(); continue }
      resolved.push(part)
      const next = links.get(resolved.join('/').normalize('NFC').toLowerCase())
      if (next !== undefined) {
        check(++hops <= 40, 'Cyclic/excessive ZIP symlink traversal')
        resolved.pop(); pending.unshift(...next.split('/'))
      }
    }
  }
}

/** Rebuild a compact ZIP from separately pinned central records and compressed entry payloads. */
export async function downloadMinimalZip(
  source: RangeSource, manifest: RangeManifest, file: string, components: ComponentId[],
  options: { signal?: AbortSignal; log?: (message: string) => void; fetch?: typeof fetch } = {},
): Promise<{ downloadedBytes: number }> {
  validate(source, manifest, components)
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30 * 60_000)]) : AbortSignal.timeout(30 * 60_000)
  signal.throwIfAborted()
  const fetcher = options.fetch ?? globalThis.fetch
  let downloadedBytes = 0
  async function range(start: number, length: number): Promise<Buffer> {
    signal.throwIfAborted()
    check(integer(start) && length > 0 && length <= MAX_CHUNK && start + length <= source.bytes, 'Invalid HTTP range bounds')
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    const request = fetcher(source.url, { redirect: 'manual', headers: { Range: 'bytes=' + start + '-' + (start + length - 1), 'Accept-Encoding': 'identity' }, signal: requestSignal })
    void request.then(r => { if (requestSignal.aborted) cancel(r.body) }, () => {})
    const response = await abortable(request, requestSignal)
    if ((response.url && response.url !== source.url) || response.redirected || (response.status >= 300 && response.status < 400)) { cancel(response.body); throw Error('Pinned URL redirect mismatch') }
    if (response.status === 200 || response.status === 416) { cancel(response.body); throw new RangeUnsupportedError('HTTP Range unsupported: ' + response.status) }
    const expected = 'bytes ' + start + '-' + (start + length - 1) + '/' + source.bytes
    if (response.status !== 206 || response.headers.get('content-range') !== expected || response.headers.get('content-length') !== String(length) || response.headers.has('content-encoding') || !response.body) { cancel(response.body); throw Error('Invalid HTTP Range response/status/headers') }
    const reader = response.body.getReader(), result = Buffer.allocUnsafe(length)
    let read = 0
    try {
      for (;;) {
        const idle = AbortSignal.any([requestSignal, AbortSignal.timeout(30_000)])
        const chunk = await abortable(reader.read(), idle)
        if (chunk.done) break
        check(chunk.value instanceof Uint8Array && chunk.value.byteLength > 0 && read + chunk.value.byteLength <= length, 'Overlong/empty HTTP Range body')
        result.set(chunk.value, read); read += chunk.value.byteLength
      }
      check(read === length, 'Truncated HTTP Range body')
      requestSignal.throwIfAborted(); downloadedBytes += read
      return result
    } catch (error) { void reader.cancel().catch(() => {}); throw error }
    finally { reader.releaseLock() }
  }
  // Exclusive creation is deliberately before network I/O. Existing caller files are never removed.
  const target = resolve(file), handle = await fs.open(target, 'wx', 0o600), owned = await handle.stat()
  let complete = false
  try {
    const cd = manifest.centralDirectory, central = await range(cd.offset, cd.bytes)
    check(digest(central) === cd.sha256.toLowerCase(), 'Central directory SHA256 mismatch')
    const parsed = parseCentral(central, cd.offset), byName = new Map(parsed.map(e => [e.name, e]))
    const tail = await range(cd.offset + cd.bytes, source.bytes - cd.offset - cd.bytes)
    check(tail.length >= 22 && tail.readUInt32LE(0) === 0x06054b50, 'Unsupported ZIP64/invalid ZIP end record')
    check(tail.readUInt16LE(4) === 0 && tail.readUInt16LE(6) === 0 && tail.readUInt16LE(8) !== 65535 && tail.readUInt16LE(10) !== 65535 && tail.readUInt16LE(8) === parsed.length && tail.readUInt16LE(10) === parsed.length && tail.readUInt32LE(12) === cd.bytes && tail.readUInt32LE(16) === cd.offset && 22 + tail.readUInt16LE(20) === tail.length, 'Invalid ZIP32 end count/bounds (multi-disk/ZIP64 unsupported)')
    const chosen = new Set(components), selected: Array<{ entry: Entry; sha256: string }> = []
    for (const pin of manifest.entries) {
      const entry = byName.get(pin.name)
      check(entry && entry.local === pin.localOffset && entry.packed === pin.compressedBytes && entry.bytes === pin.bytes, 'Range manifest/central index mismatch: ' + pin.name)
      check(pin.kind === undefined || pin.kind === (entry.link ? 'symlink' : entry.directory ? 'directory' : 'file'), 'Pinned ZIP kind mismatch')
      check(pin.mode === undefined || pin.mode === ((entry.raw.readUInt32LE(38) >>> 16) & 0o777), 'Pinned ZIP mode mismatch')
      if (chosen.has(pin.component)) selected.push({ entry, sha256: pin.sha256.toLowerCase() })
    }
    selected.sort((a, b) => a.entry.local - b.entry.local)
    // Central-pinned next offsets bound each local record. Overfetch at most a header extra
    // allowance, then coalesce nearby selected records; never scan an unselected huge payload.
    const spans: Array<{ start: number; end: number }> = []
    for (const { entry } of selected) {
      const end = Math.min(entry.bound, entry.local + 30 + entry.nameBytes.length + 65535 + entry.packed)
      const last = spans.at(-1)
      if (last && entry.local - last.end <= GAP && end - last.start <= MAX_CHUNK) last.end = end
      else spans.push({ start: entry.local, end })
    }
    let cached: Buffer = Buffer.alloc(0), cacheStart = -1
    async function readAt(offset: number, length: number): Promise<Buffer> {
      const result = Buffer.allocUnsafe(length)
      let copied = 0
      while (copied < length) {
        signal.throwIfAborted()
        const at = offset + copied
        if (at < cacheStart || at >= cacheStart + cached.length) {
          const span = spans.find(s => s.start <= at && at < s.end)
          check(span, 'Local read outside pinned bounds')
          cacheStart = at; cached = await range(at, Math.min(MAX_CHUNK, span.end - at))
        }
        const from = at - cacheStart, n = Math.min(length - copied, cached.length - from)
        cached.copy(result, copied, from, from + n); copied += n
      }
      return result
    }
    let written = 0
    async function write(data: Buffer) {
      signal.throwIfAborted(); check(written + data.length < ZIP32, 'Rebuilt ZIP32 size limit')
      let at = 0
      while (at < data.length) { signal.throwIfAborted(); const n = (await handle.write(data, at, data.length - at, written + at)).bytesWritten; check(n > 0, 'Short ZIP output write'); at += n }
      written += data.length
    }
    const records: Buffer[] = [], links = new Map<string, string>()
    for (const { entry, sha256 } of selected) {
      const fixed = await readAt(entry.local, 30)
      check(fixed.readUInt32LE(0) === 0x04034b50 && fixed.readUInt16LE(4) === entry.raw.readUInt16LE(6) && fixed.readUInt16LE(6) === entry.flags && fixed.readUInt16LE(8) === entry.method, 'Mismatched local ZIP header/flags/method')
      const n = fixed.readUInt16LE(26), x = fixed.readUInt16LE(28), payload = entry.local + 30 + n + x
      check(n === entry.nameBytes.length && payload + entry.packed <= entry.bound, 'Invalid local ZIP header bounds')
      const variable = await readAt(entry.local + 30, n + x)
      check(variable.subarray(0, n).equals(entry.nameBytes), 'Mismatched local ZIP path')
      extras(variable.subarray(n), entry.nameBytes)
      const crc = fixed.readUInt32LE(14), packed = fixed.readUInt32LE(18), bytes = fixed.readUInt32LE(22)
      check(integer(packed) && integer(bytes), 'Unsupported local ZIP64 sizes')
      check(entry.flags & 8 ? (crc === 0 || crc === entry.crc) && (packed === 0 || packed === entry.packed) && (bytes === 0 || bytes === entry.bytes) : crc === entry.crc && packed === entry.packed && bytes === entry.bytes, 'Mismatched local ZIP CRC/sizes')
      const local = Buffer.concat([fixed, variable]), record = Buffer.from(entry.raw)
      record.writeUInt32LE(written, 42); record.writeUInt16LE(entry.flags & ~8, 8)
      local.writeUInt16LE(entry.flags & ~8, 6); local.writeUInt32LE(entry.crc, 14); local.writeUInt32LE(entry.packed, 18); local.writeUInt32LE(entry.bytes, 22)
      await write(local)
      const hash = createHash('sha256'), linkParts: Buffer[] = []
      for (let at = 0; at < entry.packed;) {
        const bytes = await readAt(payload + at, Math.min(4 * 1024 ** 2, entry.packed - at))
        hash.update(bytes); if (entry.link) linkParts.push(bytes)
        await write(bytes); at += bytes.length
      }
      check(hash.digest('hex') === sha256, 'Compressed payload SHA256 mismatch: ' + entry.name)
      if (entry.link) links.set(entry.key, symlink(entry, Buffer.concat(linkParts)))
      records.push(record)
    }
    validateLinkGraph(links)
    const centralOffset = written
    for (const record of records) await write(record)
    const centralBytes = written - centralOffset, end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10)
    end.writeUInt32LE(centralBytes, 12); end.writeUInt32LE(centralOffset, 16); await write(end)
    signal.throwIfAborted(); await handle.sync(); signal.throwIfAborted()
    const current = await fs.lstat(target)
    check(current.isFile() && current.dev === owned.dev && current.ino === owned.ino, 'ZIP output ownership changed')
    options.log?.('Downloaded ' + downloadedBytes + ' bytes for ' + components.join(', ') + ' (' + selected.length + ' ZIP entries)')
    signal.throwIfAborted(); complete = true; return { downloadedBytes }
  } finally {
    try { await handle.close() } catch (error) { complete = false; throw error } finally {
      if (!complete) {
        // Only unlink the exact inode created above, never a replacement or pre-existing path.
        const current = await fs.lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
        if (current && current.dev === owned.dev && current.ino === owned.ino && current.isFile()) await fs.unlink(target)
      }
    }
  }
}
