import { it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url),'utf8')).version
it('emits exact package/version/tag fields for Actions', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'codex-release-metadata-'))
  try {
    const output = join(dir, 'output')
    execFileSync(process.execPath, ['scripts/release-metadata.mjs'], {env:{...process.env,GITHUB_OUTPUT:output,EXPECTED_VERSION:version,RELEASE_TAG:'v'+version}})
    expect(await fs.readFile(output,'utf8')).toBe('version='+version+'\ndist_tag='+(version.includes('-')?'experimental':'latest')+'\ntarball=dsh-codex-computer-use-'+version+'.tgz\n')
  } finally { await fs.rm(dir, {recursive:true,force:true}) }
})
it.each([{EXPECTED_VERSION:'0.0.0-mismatch'},{RELEASE_TAG:'v0.0.0-mismatch'},{EXPECTED_VERSION:version+'\nmalicious=1'}])('rejects inconsistent/untrusted event fields: %j', values => {
  const r = spawnSync(process.execPath, ['scripts/release-metadata.mjs'], {encoding:'utf8',env:{...process.env,EXPECTED_VERSION:'',RELEASE_TAG:'',...values}})
  expect(r.status).toBe(1)
})
