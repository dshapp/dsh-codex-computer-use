import { it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('emits exact package/version/tag fields for Actions', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'codex-release-metadata-'))
  try {
    const output = join(dir, 'output')
    execFileSync(process.execPath, ['scripts/release-metadata.mjs'], {env:{...process.env,GITHUB_OUTPUT:output,EXPECTED_VERSION:'0.1.0-experimental.4',RELEASE_TAG:'v0.1.0-experimental.4'}})
    expect(await fs.readFile(output,'utf8')).toBe('version=0.1.0-experimental.4\ndist_tag=experimental\ntarball=dsh-codex-computer-use-0.1.0-experimental.4.tgz\n')
  } finally { await fs.rm(dir, {recursive:true,force:true}) }
})
it.each([{EXPECTED_VERSION:'0.1.0-experimental.3'},{RELEASE_TAG:'v0.1.0-experimental.3'},{EXPECTED_VERSION:'0.1.0-experimental.4\nmalicious=1'}])('rejects inconsistent/untrusted event fields: %j', values => {
  const r = spawnSync(process.execPath, ['scripts/release-metadata.mjs'], {encoding:'utf8',env:{...process.env,EXPECTED_VERSION:'',RELEASE_TAG:'',...values}})
  expect(r.status).toBe(1)
})
