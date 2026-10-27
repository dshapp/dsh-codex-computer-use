/** Maintainer-only: pin partial official bytes, then verify every reconstructed signed component. No archive code executes. */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
const root=resolve(import.meta.dirname,'..'),s=JSON.parse(await fs.readFile(join(root,'runtime-source.json'),'utf8'))
const destination=join(root,'artifacts/minimal-validation'),prefix='ChatGPT.app/Contents/Resources/'
await fs.mkdir(destination,{recursive:true})
const digest=b=>createHash('sha256').update(b).digest('hex')
let transferred=0
async function range(a,b){const r=await fetch(s.url,{headers:{Range:'bytes='+a+'-'+b},redirect:'error',signal:AbortSignal.timeout(180000)});if(r.status!==206||r.headers.get('content-range')!=='bytes '+a+'-'+b+'/'+s.bytes){await r.body?.cancel();throw Error('Invalid byte-range response')};const data=Buffer.from(await r.arrayBuffer());if(data.length!==b-a+1)throw Error('Incorrect range length');transferred+=data.length;return data}
const tail=await range(s.bytes-65557,s.bytes-1);let end=-1;for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break}if(end<0)throw Error('No ZIP end')
const centralBytes=tail.readUInt32LE(end+12),centralOffset=tail.readUInt32LE(end+16),central=await range(centralOffset,centralOffset+centralBytes-1)
if(digest(central)!=='c3ea49b8f1218c16520778799587d80858cb9cfe2e8f3c58838a42994538e0f9')throw Error('Original pinned central directory changed')
const all=[];let p=0
while(p<central.length){if(central.readUInt32LE(p)!==0x02014b50)throw Error('Bad directory');const n=central.readUInt16LE(p+28),x=central.readUInt16LE(p+30),c=central.readUInt16LE(p+32),len=46+n+x+c,record=Buffer.from(central.subarray(p,p+len)),name=record.subarray(46,46+n).toString('utf8'),mode=record.readUInt32LE(38)>>>16
const component=name.startsWith(prefix+'cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/')?'cu':name.startsWith(prefix+'codex-cli/CodexCLI.app/')?'cli':[prefix+'cua_node/bin/node',prefix+'cua_node/LICENSE'].includes(name)?'node':undefined
all.push({name,component,record,localOffset:record.readUInt32LE(42),compressedBytes:record.readUInt32LE(20),bytes:record.readUInt32LE(24),mode:mode&0o777,kind:name.endsWith('/')?'directory':(mode&0xf000)===0xa000?'symlink':'file'});p+=len}
all.sort((a,b)=>a.localOffset-b.localOffset);for(let i=0;i<all.length;i++)all[i].recordEnd=(all[i+1]?.localOffset??centralOffset)-1
const selected=all.filter(e=>e.component),groups=[]
for(const e of selected){const last=groups.at(-1);if(last&&e.localOffset-last.end<=65536&&e.recordEnd-last.start<128*1024**2){last.end=e.recordEnd;last.entries.push(e)}else groups.push({start:e.localOffset,end:e.recordEnd,entries:[e]})}
const locals=[],records=[],entries=[];let outputOffset=0
for(const group of groups){console.log('Fetch selected span',group.start,group.end,group.entries.length);const data=await range(group.start,group.end)
for(const e of group.entries){const offset=e.localOffset-group.start,head=data.subarray(offset,offset+30);if(head.readUInt32LE(0)!==0x04034b50)throw Error('Bad local header');const nameBytes=head.readUInt16LE(26),extra=head.readUInt16LE(28),length=30+nameBytes+extra,local=Buffer.from(data.subarray(offset,offset+length)),payload=data.subarray(offset+length,offset+length+e.compressedBytes);if(local.subarray(30,30+nameBytes).toString('utf8')!==e.name||payload.length!==e.compressedBytes)throw Error('Bad entry bounds');const flags=head.readUInt16LE(6),method=head.readUInt16LE(8);if(flags!==e.record.readUInt16LE(8)||method!==e.record.readUInt16LE(10)||flags&1)throw Error('Inconsistent entry');const raw=method===8?inflateRawSync(payload,{maxOutputLength:512*1024**2}):payload;if(raw.length!==e.bytes)throw Error('Bad uncompressed size');
entries.push({name:e.name,component:e.component,localOffset:e.localOffset,compressedBytes:e.compressedBytes,bytes:e.bytes,sha256:digest(payload),uncompressedSha256:digest(raw),mode:e.mode,kind:e.kind})
local.writeUInt16LE(flags&~8,6);e.record.writeUInt16LE(flags&~8,8);e.record.copy(local,14,16,28);e.record.writeUInt32LE(outputOffset,42);locals.push(local,Buffer.from(payload));records.push(e.record);outputOffset+=local.length+payload.length}}
const directory=Buffer.concat(records),footer=Buffer.alloc(22);footer.writeUInt32LE(0x06054b50);footer.writeUInt16LE(entries.length,8);footer.writeUInt16LE(entries.length,10);footer.writeUInt32LE(directory.length,12);footer.writeUInt32LE(outputOffset,16)
const archive=join(destination,'minimal.zip');await fs.writeFile(archive,Buffer.concat([...locals,directory,footer]));const extracted=join(destination,'extracted');await fs.mkdir(extracted);execFileSync('/usr/bin/ditto',['-x','-k',archive,extracted])
const resources=join(extracted,prefix),app=join(resources,'cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app')
for(const path of [join(resources,'cua_node/bin/node'),join(resources,'codex-cli/CodexCLI.app'),app]){execFileSync('/usr/bin/codesign',['--verify','--deep','--strict','--test-requirement','=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"','--verbose=2',path],{stdio:'inherit'})}
// Compare full byte/symlink trees to original same-cohort installed app; never read account/config/session data.
for(const entry of entries){const original=join('/Applications',entry.name),stat=await fs.lstat(original);let raw;if(entry.kind==='directory'){if(!stat.isDirectory())throw Error('Original directory mismatch');continue}else if(entry.kind==='symlink')raw=Buffer.from(await fs.readlink(original));else raw=await fs.readFile(original);if(digest(raw)!==entry.uncompressedSha256)throw Error('Original signed source differs: '+entry.name)}
const manifest={version:1,sourceSha256:s.sha256,sourceBytes:s.bytes,centralDirectory:{offset:centralOffset,bytes:centralBytes,sha256:digest(central)},entries}
await fs.writeFile(join(root,'runtime-components.json'),JSON.stringify(manifest,null,2)+String.fromCharCode(10))
console.log(JSON.stringify({transferredBytes:transferred,compressedBytes:entries.reduce((n,e)=>n+e.compressedBytes,0),entries:entries.length,groups:groups.length,verified:'All reconstructed component signatures and original signed file bytes match'},null,2))
