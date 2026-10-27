/** Clean production install/import smoke; never connects to real CU. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const dir = mkdtempSync(join(tmpdir(), 'dsh-codex-cu-pack-'))
function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180_000, env: { ...process.env, ...env } })
  if (result.error || result.status !== 0) throw new Error(command + ' failed: ' + (result.error?.message || result.stderr || result.stdout))
  return result.stdout
}
try {
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], root))
  const artifact = join(dir, packed[0].filename)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'codex-cu-pack-smoke', private: true, type: 'module' }))
  run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', artifact], dir)
  const code = [
    "import * as plugin from 'dsh-codex-computer-use';",
    "import * as skills from 'dsh-codex-computer-use/skills';",
    "import { accessSync } from 'node:fs';",
    "import { createRequire } from 'node:module';",
    "if (plugin.name !== 'codex-computer-use') throw new Error('Bad main export');",
    "accessSync(skills.resolveBundledSkillsDir() + '/codex-computer-use/SKILL.md');",
    "accessSync(createRequire(import.meta.url).resolve('dsh-codex-computer-use/cordis.patch.yml'));",
    "console.log('Production package main, skills and bundle patch import OK; no CU calls.');",
  ].join(' ')
  console.log(run(process.execPath, ['--input-type=module', '-e', code], dir).trim())
  console.log(run(process.execPath, [join(dir, 'node_modules/dsh-codex-computer-use/lib/doctor.js'), '--help'], dir).trim())
  console.log(run(process.execPath, [join(dir, 'node_modules/.bin/dsh-codex-cu-setup'), '--help'], dir).trim())
  // Also exercise the actual lifecycle entry, explicitly opting out of downloads.
  const lifecycle = run(process.execPath, [join(dir, 'node_modules/dsh-codex-computer-use/install.mjs')], dir, { DSH_CODEX_CU_SKIP_SETUP: '1' })
  console.log('Postinstall entry runs with explicit CI skip; first-start recovery is covered separately.')
  console.log('Packed package contains ' + packed[0].files.length + ' files.')
} finally {
  // mkdtemp returned this exact temporary directory; no user-provided deletion path.
  rmSync(dir, { recursive: true, force: true })
}
