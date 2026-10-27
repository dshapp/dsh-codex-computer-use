import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadMinimalZip, RangeUnsupportedError } from '../src/range-runtime.ts'
import type { ComponentId, RangeManifest, RangeSource } from '../src/range-runtime.ts'

const directories: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const d of directories.splice(0)) await fs.rm(d, { recursive: true, force: true }) })
async function output() { const d = await fs.mkdtemp(join(tmpdir(), 'range-runtime-test-')); directories.push(d); return join(d, 'minimal.zip') }
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
function crc32(data: Uint8Array) {
  let crc = 0xffffffff
  for (const b of data) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function extra(id: number, data = Buffer.from('extra')) { const b = Buffer.alloc(4); b.writeUInt16LE(id); b.writeUInt16LE(data.length, 2); return Buffer.concat([b, data]) }
interface Spec { name: string; data?: string | Buffer; component?: ComponentId | null; method?: number; mode?: number; flags?: number; localExtra?: Buffer; centralExtra?: Buffer; gap?: number }
function fixture(specs: Spec[] = [{ name: 'node/bin/node', data: 'node payload', component: 'node' }]) {
  const locals: Buffer[] = [], records: Buffer[] = [], pins: RangeManifest['entries'] = [], members: Array<{ local: number; central: number; packed: Buffer; bytes: Buffer }> = []
  let offset = 0, centralAt = 0
  for (const spec of specs) {
    const name = Buffer.from(spec.name), bytes = Buffer.from(spec.data ?? ''), method = spec.method ?? 0, flags = spec.flags ?? 0x800, mode = spec.mode ?? (spec.name.endsWith('/') ? 0o40755 : 0o100755)
    const packed = method === 8 ? deflateRawSync(bytes) : bytes, lx = spec.localExtra ?? Buffer.alloc(0), cx = spec.centralExtra ?? Buffer.alloc(0)
    const fixed = Buffer.alloc(30); fixed.writeUInt32LE(0x04034b50); fixed.writeUInt16LE(20, 4); fixed.writeUInt16LE(flags, 6); fixed.writeUInt16LE(method, 8)
    fixed.writeUInt16LE(0x1234, 10); fixed.writeUInt16LE(0x4321, 12)
    if (!(flags & 8)) { fixed.writeUInt32LE(crc32(bytes), 14); fixed.writeUInt32LE(packed.length, 18); fixed.writeUInt32LE(bytes.length, 22) }
    fixed.writeUInt16LE(name.length, 26); fixed.writeUInt16LE(lx.length, 28)
    const descriptor = Buffer.alloc(flags & 8 ? 16 : 0)
    if (descriptor.length) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc32(bytes), 4); descriptor.writeUInt32LE(packed.length, 8); descriptor.writeUInt32LE(bytes.length, 12) }
    const local = Buffer.concat([fixed, name, lx, packed, descriptor, Buffer.alloc(spec.gap ?? 0)])
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0x1234, 12); central.writeUInt16LE(0x4321, 14); central.writeUInt32LE(crc32(bytes), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(cx.length, 30); central.writeUInt32LE(((mode << 16) | (spec.name.endsWith('/') ? 0x10 : 0)) >>> 0, 38); central.writeUInt32LE(offset, 42)
    const record = Buffer.concat([central, name, cx]); records.push(record); locals.push(local)
    members.push({ local: offset, central: centralAt, packed, bytes })
    if (spec.component !== null) pins.push({ name: spec.name, component: spec.component ?? 'node', localOffset: offset, compressedBytes: packed.length, bytes: bytes.length, sha256: sha(packed) })
    offset += local.length; centralAt += record.length
  }
  const central = Buffer.concat(records), eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(specs.length, 8); eocd.writeUInt16LE(specs.length, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(offset, 16)
  const zip = Buffer.concat([...locals, central, eocd])
  const source: RangeSource = { url: 'https://persistent.oaistatic.com/codex-app-prod/fixture.zip', bytes: zip.length, sha256: sha(zip) }
  const manifest: RangeManifest = { version: 1, sourceSha256: source.sha256, sourceBytes: source.bytes, centralDirectory: { offset, bytes: central.length, sha256: sha(central) }, entries: pins }
  return { zip, source, manifest, members }
}
type Fixture = ReturnType<typeof fixture>
function repinCentral(f: Fixture) { const c = f.manifest.centralDirectory; c.sha256 = sha(f.zip.subarray(c.offset, c.offset + c.bytes)) }
function mockFetch(f: Fixture, change?: (response: Response, body: Buffer, start: number, end: number, call: number) => Response | Promise<Response>) {
  const ranges: Array<{ start: number; end: number }> = []
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(url).toBe(f.source.url); expect(init?.redirect).toBe('manual'); expect(new Headers(init?.headers).get('accept-encoding')).toBe('identity')
    const range = new Headers(init?.headers).get('range')!, match = /^bytes=(\d+)-(\d+)$/.exec(range)!
    expect(match).not.toBeNull()
    const start = Number(match[1]), end = Number(match[2]); ranges.push({ start, end })
    const body = Buffer.from(f.zip.subarray(start, end + 1))
    const response = new Response(body, { status: 206, headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + f.source.bytes, 'Content-Length': String(end - start + 1) } })
    return change ? change(response, body, start, end, ranges.length) : response
  }) as unknown as typeof fetch
  return { fetch: fetcher, ranges }
}
function unpackRebuilt(zip: Buffer) {
  const end = zip.length - 22; expect(zip.readUInt32LE(end)).toBe(0x06054b50)
  const count = zip.readUInt16LE(end + 10), offset = zip.readUInt32LE(end + 16), length = zip.readUInt32LE(end + 12)
  expect(zip.readUInt16LE(end + 8)).toBe(count); expect(offset + length).toBe(end)
  const result: Array<{ name: string; data: Buffer; local: Buffer; central: Buffer }> = []
  let at = offset
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50)
    const n = zip.readUInt16LE(at + 28), x = zip.readUInt16LE(at + 30), c = zip.readUInt16LE(at + 32), central = zip.subarray(at, at + 46 + n + x + c), name = central.subarray(46, 46 + n).toString()
    const lo = central.readUInt32LE(42), ln = zip.readUInt16LE(lo + 26), lx = zip.readUInt16LE(lo + 28), local = zip.subarray(lo, lo + 30 + ln + lx)
    expect(local.readUInt32LE(0)).toBe(0x04034b50); expect(local.subarray(30, 30 + ln).toString()).toBe(name)
    expect(local.readUInt16LE(6)).toBe(central.readUInt16LE(8)); expect(local.readUInt16LE(6) & 8).toBe(0)
    expect(local.readUInt32LE(14)).toBe(central.readUInt32LE(16)); expect(local.readUInt32LE(18)).toBe(central.readUInt32LE(20)); expect(local.readUInt32LE(22)).toBe(central.readUInt32LE(24))
    const packed = zip.subarray(lo + local.length, lo + local.length + central.readUInt32LE(20)), data = central.readUInt16LE(10) === 8 ? inflateRawSync(packed) : packed
    expect(data.length).toBe(central.readUInt32LE(24)); expect(crc32(data)).toBe(central.readUInt32LE(16))
    result.push({ name, data, local, central }); at += central.length
  }
  expect(at).toBe(end)
  return result
}
async function fails(f: Fixture, expression: RegExp, fetcher = mockFetch(f).fetch) {
  const file = await output()
  const error = await downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: fetcher }).catch(e => e)
  expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(RangeUnsupportedError); expect(error.message).toMatch(expression)
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('selective pinned ZIP range downloads (synthetic, no signatures/native CU/network)', () => {
  it('rebuilds sparse selected components with correct counters/modes/extras and excludes a large unselected payload', async () => {
    const f = fixture([
      { name: 'ignored/huge', data: Buffer.alloc(200_000, 7), component: null },
      { name: 'node/bin/node', data: 'node executable', component: 'node', method: 8, localExtra: extra(0xcafe), centralExtra: extra(0xbeef) },
      { name: 'cli/codex', data: 'cli executable', component: 'cli' },
      { name: 'cu/app/', component: 'cu' },
      { name: 'cu/app/client', data: 'CU executable', component: 'cu', method: 8 },
    ])
    const file = await output(), m = mockFetch(f), log = vi.fn(), result = await downloadMinimalZip(f.source, f.manifest, file, ['node', 'cu'], { fetch: m.fetch, log })
    const entries = unpackRebuilt(await fs.readFile(file))
    expect(entries.map(e => e.name)).toEqual(['node/bin/node', 'cu/app/', 'cu/app/client']); expect(entries[0]!.data.toString()).toBe('node executable')
    expect(entries[0]!.central.readUInt32LE(38) >>> 16).toBe(0o100755)
    expect(entries[0]!.local.subarray(30 + Buffer.byteLength(entries[0]!.name))).toEqual(extra(0xcafe))
    expect(entries[0]!.central.subarray(46 + Buffer.byteLength(entries[0]!.name))).toEqual(extra(0xbeef))
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(result.downloadedBytes).toBe(m.ranges.reduce((n, r) => n + r.end - r.start + 1, 0)); expect(result.downloadedBytes).toBeLessThan(f.zip.length / 5)
    expect(m.ranges).toHaveLength(3); expect(m.ranges[2]!.start).toBe(f.members[1]!.local); expect(log).toHaveBeenCalledOnce()
  })
  it('coalesces 230 nearby CU records into one local request rather than per-header requests', async () => {
    const f = fixture(Array.from({ length: 230 }, (_, i) => ({ name: 'cu/app/file-' + i, data: 'small CU member', component: 'cu' as const, gap: i % 7 === 0 ? 100 : 0 })))
    const file = await output(), m = mockFetch(f)
    const r = await downloadMinimalZip(f.source, f.manifest, file, ['cu'], { fetch: m.fetch })
    expect(m.ranges).toHaveLength(3); expect(unpackRebuilt(await fs.readFile(file))).toHaveLength(230); expect(r.downloadedBytes).toBe(f.zip.length)
  })
  it('does not bridge an unselected gap larger than 64KiB', async () => {
    const f = fixture([{ name: 'node/a', data: 'a' }, { name: 'other/large', data: Buffer.alloc(70_000), component: null }, { name: 'node/b', data: 'b' }])
    const m = mockFetch(f); await downloadMinimalZip(f.source, f.manifest, await output(), ['node'], { fetch: m.fetch })
    expect(m.ranges).toHaveLength(4); expect(m.ranges[2]!.end).toBe(f.members[1]!.local - 1); expect(m.ranges[3]!.start).toBe(f.members[2]!.local)
  })
  it('normalizes data-descriptor bit8 local/central flags and CRC/sizes without copying descriptors', async () => {
    const f = fixture([{ name: 'node/descriptor', data: 'compress me '.repeat(500), method: 8, flags: 0x808 }]), file = await output()
    await downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: mockFetch(f).fetch })
    const zip = await fs.readFile(file), [entry] = unpackRebuilt(zip)
    expect(entry!.data.toString()).toBe('compress me '.repeat(500)); expect(zip.length).toBe(f.zip.length - 16)
  })
  it('accepts bounded relative stored/deflated symlinks and empty directory payload hash', async () => {
    const f = fixture([{ name: 'node/dir/' }, { name: 'node/dir/file', data: 'ok' }, { name: 'node/alias', data: 'dir/file', mode: 0o120777, method: 8 }, { name: 'node/other', data: 'alias', mode: 0o120777 }])
    expect(f.manifest.entries[0]!.sha256).toBe(sha(Buffer.alloc(0)))
    const file = await output(); await downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: mockFetch(f).fetch })
    expect(unpackRebuilt(await fs.readFile(file))[2]!.central.readUInt32LE(38) >>> 16).toBe(0o120777)
  })
  it('streams bounded multi-chunk responses and handles body chunk boundaries', async () => {
    const f = fixture([{ name: 'node/a', data: 'some bytes', method: 8 }])
    const m = mockFetch(f, (response, bytes) => new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close() } }), { status: 206, headers: response.headers }))
    const file = await output(); await downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: m.fetch }); expect(unpackRebuilt(await fs.readFile(file))[0]!.data.toString()).toBe('some bytes')
  })

  it('rejects central SHA corruption', async () => { const f = fixture(); f.zip[f.manifest.centralDirectory.offset + 12] ^= 1; await fails(f, /Central.*SHA256/) })
  it('rejects compressed-payload SHA corruption', async () => { const f = fixture(); f.zip[30 + Buffer.byteLength(f.manifest.entries[0]!.name)] ^= 1; await fails(f, /payload SHA256/) })
  it('rejects a corrupt pinned payload hash', async () => { const f = fixture(); f.manifest.entries[0]!.sha256 = 'a'.repeat(64); await fails(f, /payload SHA256/) })
  it.each(['localOffset', 'compressedBytes', 'bytes', 'name'] as const)('requires exact manifest/central matching for %s', async field => {
    const f = fixture(), pin = f.manifest.entries[0]!
    if (field === 'name') pin.name = 'node/missing'; else pin[field]++
    await fails(f, /index mismatch/)
  })
  it('also validates central matches of unselected manifest entries', async () => {
    const f = fixture([{ name: 'node/a' }, { name: 'cli/a', component: 'cli' }]); f.manifest.entries[1]!.localOffset++
    await fails(f, /index mismatch/)
  })
  it.each([0, 4, 6, 8, 14, 18, 22, 26, 28, 30])('rejects local header corruption at byte %s', async at => {
    const f = fixture(); f.zip[at] ^= 1; await fails(f, /local ZIP/)
  })
  it('rejects malformed/ZIP64 local extras', async () => {
    const f = fixture([{ name: 'node/a', localExtra: extra(1, Buffer.alloc(8)) }]); await fails(f, /ZIP64/)
  })
  it.each(['../escape', '/absolute', 'C:/drive', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'a\0b', ''])('rejects unsafe manifest path %j before I/O', async name => {
    const f = fixture(); f.manifest.entries[0]!.name = name; const m = mockFetch(f); await fails(f, /Unsafe ZIP path/, m.fetch); expect(m.ranges).toHaveLength(0)
  })
  it('rejects central traversal even in an unselected entry', async () => {
    const f = fixture([{ name: 'node/a' }, { name: '../bad', component: null }]); await fails(f, /Unsafe ZIP path/)
  })
  it.each([['a', 'a/'], ['a', 'A'], ['é', 'é'], ['a', 'a/b']])('rejects collisions %j', async (a, b) => {
    const f = fixture([{ name: a!, component: null }, { name: b!, component: null }, { name: 'node/x' }]); await fails(f, /collid|collision/)
  })
  it('rejects descendants of symlink parents even if unselected', async () => {
    const f = fixture([{ name: 'node/link', data: 'dir', mode: 0o120777 }, { name: 'node/link/child', component: null }]); await fails(f, /symlink parent/)
  })
  it.each(['/etc/passwd', '../../../escape', 'C:/drive', '..\\escape', 'a\0b'])('rejects unsafe symlink target %j', async data => {
    const f = fixture([{ name: 'node/link', data, mode: 0o120777, method: 8 }]); await fails(f, /symlink target/)
  })
  it('rejects symlink traversal that only escapes after following another link', async () => {
    const f = fixture([{ name: 'node/to-root', data: '..', mode: 0o120777 }, { name: 'node/link', data: 'to-root/../escape', mode: 0o120777 }]); await fails(f, /symlink traversal/)
  })
  it('rejects cyclic symlinks', async () => { const f = fixture([{ name: 'node/a', data: 'b', mode: 0o120777 }, { name: 'node/b', data: 'a', mode: 0o120777 }]); await fails(f, /Cyclic/) })
  it('bounds deflated symlink inflation even if central lies about unpacked bytes', async () => {
    const f = fixture([{ name: 'node/link', data: 'x'.repeat(4097), mode: 0o120777, method: 8, flags: 0x808 }]); f.zip.writeUInt32LE(4096, f.manifest.centralDirectory.offset + 24); f.manifest.entries[0]!.bytes = 4096; repinCentral(f)
    await fails(f, /larger|size|length/i)
  })
  it.each([0x1000, 0x2000, 0x6000, 0xc000])('rejects ZIP special file mode %s', async kind => { const f = fixture([{ name: 'node/special', mode: kind | 0o777 }]); await fails(f, /Special file/) })
  it.each([1, 0x40, 0x2000, 0x10])('rejects encryption/unsupported central flags %s', async flags => { const f = fixture([{ name: 'node/a', flags }]); await fails(f, /flags.*encryption/) })
  it('rejects unsupported compression', async () => { const f = fixture([{ name: 'node/a', method: 12 }]); await fails(f, /method/) })
  it.each([20, 24, 42])('rejects ZIP64 central sentinel at %s', async at => { const f = fixture(); f.zip.writeUInt32LE(0xffffffff, f.manifest.centralDirectory.offset + at); repinCentral(f); await fails(f, /ZIP64/) })
  it('rejects ZIP64 central extras', async () => { const f = fixture([{ name: 'node/a', centralExtra: extra(1, Buffer.alloc(8)) }]); await fails(f, /ZIP64/) })
  it('rejects ZIP64 version and multi-disk indexes', async () => {
    for (const [at, value] of [[6, 45], [34, 1]]) { const f = fixture(); f.zip.writeUInt16LE(value!, f.manifest.centralDirectory.offset + at!); repinCentral(f); await fails(f, /ZIP64.*multi-disk/) }
  })
  it('rejects malformed central record bounds', async () => { const f = fixture(); f.zip.writeUInt16LE(65535, f.manifest.centralDirectory.offset + 28); repinCentral(f); await fails(f, /central bounds/) })
  it('rejects overlapping pinned local offsets', async () => {
    const f = fixture([{ name: 'node/a', data: 'a' }, { name: 'node/b', data: 'b' }]); f.zip.writeUInt32LE(1, f.manifest.centralDirectory.offset + f.members[1]!.central + 42); repinCentral(f); await fails(f, /Overlapping/)
  })
  it('rejects malformed central extras and path overrides', async () => {
    await fails(fixture([{ name: 'node/a', centralExtra: Buffer.from([2, 0, 50, 0]) }]), /Malformed ZIP extra/)
    await fails(fixture([{ name: 'node/a', centralExtra: extra(0x7075, Buffer.concat([Buffer.from([1, 0, 0, 0, 0]), Buffer.from('../bad')])) }]), /path override/)
  })

  it.each([200, 416])('only unsupported Range %s gets the fallback error and cancels without consumption', async status => {
    const f = fixture(), cancelled = vi.fn(), pulled = vi.fn(), m = mockFetch(f, () => new Response(new ReadableStream({ pull: pulled, cancel: cancelled }, { highWaterMark: 0 }), { status })), file = await output()
    await expect(downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: m.fetch })).rejects.toBeInstanceOf(RangeUnsupportedError)
    expect(cancelled).toHaveBeenCalledOnce(); expect(pulled).not.toHaveBeenCalled(); expect(m.ranges).toHaveLength(1); await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each([401, 403, 404, 500])('HTTP %s is a hard failure, never fallback', async status => { const f = fixture(); await fails(f, /response.*status/, mockFetch(f, () => new Response('error', { status })).fetch) })
  it.each(['wrong-total', 'wrong-start', 'wrong-end', 'missing-range', 'missing-length', 'wrong-length', 'encoding'])('rejects %s response headers', async mutation => {
    const f = fixture(), m = mockFetch(f, response => {
      if (mutation === 'encoding') response.headers.set('content-encoding', 'gzip')
      else if (mutation === 'missing-range') response.headers.delete('content-range')
      else if (mutation === 'missing-length') response.headers.delete('content-length')
      else if (mutation === 'wrong-length') response.headers.set('content-length', '0')
      else { const c = f.manifest.centralDirectory; response.headers.set('content-range', 'bytes ' + (c.offset + (mutation === 'wrong-start' ? 1 : 0)) + '-' + (c.offset + c.bytes - 1 + (mutation === 'wrong-end' ? 1 : 0)) + '/' + (f.source.bytes + (mutation === 'wrong-total' ? 1 : 0))) }
      return response
    }); await fails(f, /headers/, m.fetch)
  })
  it.each(['truncated', 'overlong'])('rejects %s body despite claimed exact headers', async mutation => {
    const f = fixture(), m = mockFetch(f, (response, body) => new Response(mutation === 'truncated' ? body.subarray(0, -1) : Buffer.concat([body, Buffer.from('x')]), { status: 206, headers: response.headers }))
    await fails(f, mutation === 'truncated' ? /Truncated/ : /Overlong/, m.fetch)
  })
  it('cancels an overlong response without reading further chunks', async () => {
    const f = fixture(), cancelled = vi.fn(), m = mockFetch(f, (response, body) => new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.concat([body, Buffer.from('extra')])); }, cancel: cancelled }), { status: 206, headers: response.headers }))
    await fails(f, /Overlong/, m.fetch); expect(cancelled).toHaveBeenCalledOnce()
  })
  it.each(['https://evil.example/archive.zip', 'https://persistent.oaistatic.com/codex-app-prod/other.zip'])('rejects manual redirects to %s without following', async url => {
    const f = fixture(), m = mockFetch(f, () => new Response(null, { status: 302, headers: { Location: url } })); await fails(f, /redirect/, m.fetch); expect(m.ranges).toHaveLength(1)
  })
  it('rejects a fetch implementation that followed redirects or changed final URL', async () => {
    const f = fixture(), m = mockFetch(f, response => { Object.defineProperty(response, 'url', { value: 'https://evil.example/zip' }); return response }); await fails(f, /redirect/, m.fetch)
    const n = mockFetch(f, response => { Object.defineProperty(response, 'redirected', { value: true }); return response }); await fails(f, /redirect/, n.fetch)
  })
  it.each(['http://persistent.oaistatic.com/codex-app-prod/x.zip', 'https://persistent.oaistatic.com.evil/codex-app-prod/x.zip', 'https://persistent.oaistatic.com/other/x.zip', 'https://user:pass@persistent.oaistatic.com/codex-app-prod/x.zip', 'https://persistent.oaistatic.com/codex-app-prod/x.zip?q=1', 'https://persistent.oaistatic.com/codex-app-prod/x.zip#fragment', 'https://persistent.oaistatic.com:444/codex-app-prod/x.zip', 'https://persistent.oaistatic.com/codex-app-prod/../x.zip', 'https://persistent.oaistatic.com/codex-app-prod/%2e%2e/x.zip', 'https://persistent.oaistatic.com/codex-app-prod/%5cfoo.zip'])('rejects unpinned/unsafe URL %s before fetch', async url => {
    const f = fixture(); f.source.url = url; const m = mockFetch(f); await fails(f, /pinned official URL/, m.fetch); expect(m.ranges).toHaveLength(0)
  })
  it.each([[], ['unknown'], ['node', 'node'], ['cu']].map(components => ({ components })))('rejects missing/unrecognized component selection $components', async ({ components }) => {
    const f = fixture(), file = await output(), m = mockFetch(f)
    await expect(downloadMinimalZip(f.source, f.manifest, file, components as ComponentId[], { fetch: m.fetch })).rejects.toThrow(/component/); expect(m.ranges).toHaveLength(0)
  })
  it('rejects unrecognized manifest component and mismatched source pins', async () => {
    const f = fixture(); (f.manifest.entries[0] as { component: string }).component = 'other'; await fails(f, /manifest entry/)
    const g = fixture(); g.manifest.sourceBytes++; await fails(g, /source mismatch/)
    const h = fixture(); h.manifest.sourceSha256 = 'b'.repeat(64); await fails(h, /source mismatch/)
  })
  it('rejects invalid range manifest size/bounds before I/O', async () => { const f = fixture(); f.manifest.centralDirectory.bytes = f.source.bytes; const m = mockFetch(f); await fails(f, /pinned central directory/, m.fetch); expect(m.ranges).toHaveLength(0) })
  it('leaves existing files and symlink destinations untouched', async () => {
    const f = fixture(), file = await output(), m = mockFetch(f); await fs.writeFile(file, 'caller-owned')
    await expect(downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: m.fetch })).rejects.toMatchObject({ code: 'EEXIST' }); expect(await fs.readFile(file, 'utf8')).toBe('caller-owned')
    const link = file + '-link'; await fs.symlink(file, link)
    await expect(downloadMinimalZip(f.source, f.manifest, link, ['node'], { fetch: m.fetch })).rejects.toMatchObject({ code: 'EEXIST' }); expect((await fs.lstat(link)).isSymbolicLink()).toBe(true); expect(m.ranges).toHaveLength(0)
  })
  it('never deletes a replacement inode during failed output cleanup', async () => {
    const f = fixture(), file = await output(), m = mockFetch(f, async () => { await fs.rename(file, file + '.moved'); await fs.writeFile(file, 'replacement'); throw Error('network failure') })
    await expect(downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: m.fetch })).rejects.toThrow('network failure'); expect(await fs.readFile(file, 'utf8')).toBe('replacement')
  })
  it('pre-aborted requests create no file and do no network work', async () => {
    const f = fixture(), file = await output(), m = mockFetch(f), controller = new AbortController(); controller.abort(Error('already cancelled'))
    await expect(downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: m.fetch, signal: controller.signal })).rejects.toThrow('already cancelled'); expect(m.ranges).toHaveLength(0); await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('aborts a stalled fetch even when the injected fetch ignores signal and cleans output', async () => {
    const f = fixture(), file = await output(), controller = new AbortController(), fetcher = vi.fn(() => { queueMicrotask(() => controller.abort(Error('cancelled fetch'))); return new Promise<Response>(() => {}) }) as unknown as typeof fetch
    await expect(downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: fetcher, signal: controller.signal })).rejects.toThrow('cancelled fetch'); await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('aborts/cancels a stalled response stream and cleans partial output', async () => {
    const f = fixture(), file = await output(), controller = new AbortController(), cancelled = vi.fn(), m = mockFetch(f, response => new Response(new ReadableStream({ pull() { queueMicrotask(() => controller.abort(Error('cancelled stream'))) }, cancel: cancelled }, { highWaterMark: 0 }), { status: 206, headers: response.headers }))
    await expect(downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: m.fetch, signal: controller.signal })).rejects.toThrow('cancelled stream'); expect(cancelled).toHaveBeenCalledOnce(); await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('cleans a partially written ZIP when a later selected local request is aborted', async () => {
    const f = fixture([{ name: 'node/a', data: 'written' }, { name: 'other/huge', data: Buffer.alloc(70_000), component: null }, { name: 'node/b', data: 'later' }]), controller = new AbortController(), file = await output()
    const m = mockFetch(f, response => { if (m.ranges.length === 4) controller.abort(Error('cancelled later')); return response })
    await expect(downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: m.fetch, signal: controller.signal })).rejects.toThrow('cancelled later'); await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([[0, 0], [4, 1], [6, 1], [8, 2], [10, 65535], [12, 0], [16, 0], [20, 1]])('rejects corrupt EOCD field at $0', async (at, value) => {
    const f = fixture(), end = f.zip.length - 22
    if (at === 0 || at === 12 || at === 16) f.zip.writeUInt32LE(value, end + at)
    else f.zip.writeUInt16LE(value, end + at)
    await fails(f, /ZIP.*end|end.*ZIP|end count/)
  })
  it('rejects a ZIP64 trailer even when central entries use ZIP32-compatible sizes', async () => {
    const f = fixture(), end = f.zip.length - 22
    f.zip.writeUInt32LE(0x06064b50, end)
    await fails(f, /ZIP64/)
  })
  it('accepts an original EOCD comment but writes a compact comment-free end record', async () => {
    const f = fixture(), comment = Buffer.from('original comment')
    f.zip.writeUInt16LE(comment.length, f.zip.length - 2)
    f.zip = Buffer.concat([f.zip, comment]); f.source.bytes = f.zip.length; f.source.sha256 = sha(f.zip); f.manifest.sourceBytes = f.source.bytes; f.manifest.sourceSha256 = f.source.sha256
    const file = await output(), m = mockFetch(f)
    await downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: m.fetch })
    const zip = await fs.readFile(file); expect(zip.length).toBe(f.zip.length - comment.length); expect(unpackRebuilt(zip)).toHaveLength(1)
  })
  it('validates optional pinned kind and permission mode against authenticated central records', async () => {
    const f = fixture(); f.manifest.entries[0]!.kind = 'symlink'; await fails(f, /kind mismatch/)
    const g = fixture(); g.manifest.entries[0]!.mode = 0o600; await fails(g, /mode mismatch/)
    const h = fixture(); h.manifest.entries[0]!.uncompressedSha256 = 'not a hash'; await fails(h, /optional uncompressed/)
    const j = fixture(); Object.assign(j.manifest.entries[0]!, { kind: 'file', mode: 0o755, uncompressedSha256: sha(j.members[0]!.bytes) })
    await downloadMinimalZip(j.source, j.manifest, await output(), ['node'], { fetch: mockFetch(j).fetch })
  })
  it('rejects unauthenticated local extras capable of changing symlink or path semantics', async () => {
    await fails(fixture([{ name: 'node/a', localExtra: extra(0x756e, Buffer.alloc(14)) }]), /extra symlink/)
    await fails(fixture([{ name: 'node/a', localExtra: extra(0x000d, Buffer.alloc(20)) }]), /extra symlink/)
  })
  it('rejects empty non-final body chunks and cancels the reader', async () => {
    const f = fixture(), cancelled = vi.fn(), m = mockFetch(f, response => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(0)) }, cancel: cancelled }), { status: 206, headers: response.headers }))
    await fails(f, /empty HTTP/, m.fetch); expect(cancelled).toHaveBeenCalledOnce()
  })
  it('times out and cancels a non-closing body even after all expected bytes arrive', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal); vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => timeout(ms === 30_000 ? 10 : ms))
    const f = fixture(), file = await output(), cancelled = vi.fn(), m = mockFetch(f, (response, bytes) => new Response(new ReadableStream({ start(c) { c.enqueue(bytes) }, cancel: cancelled }), { status: 206, headers: response.headers }))
    await expect(downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: m.fetch })).rejects.toMatchObject({ name: 'TimeoutError' }); expect(cancelled).toHaveBeenCalledOnce(); await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses success if the output pathname was replaced while downloading', async () => {
    const f = fixture(), file = await output(), m = mockFetch(f, async response => { if (m.ranges.length === 1) { await fs.rename(file, file + '.owned'); await fs.writeFile(file, 'replacement') } return response })
    await expect(downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: m.fetch })).rejects.toThrow('ownership changed'); expect(await fs.readFile(file, 'utf8')).toBe('replacement')
  })
  it('hard-fails and cleans output when a logging callback throws', async () => {
    const f = fixture(), file = await output()
    await expect(downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: mockFetch(f).fetch, log() { throw Error('log failure') } })).rejects.toThrow('log failure'); await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('has a hard per-request timeout even for a stalled injected fetch', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal); vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => timeout(ms === 120_000 ? 10 : ms))
    const f = fixture(), file = await output(), fetcher = vi.fn(async () => new Promise<Response>(() => {})) as unknown as typeof fetch
    await expect(downloadMinimalZip(f.source, f.manifest, file, ['node'], { fetch: fetcher })).rejects.toMatchObject({ name: 'TimeoutError' }); await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
