#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { ensureRuntime, readPreparedRuntime, type RuntimeOptions } from './bootstrap.ts'

const usage = 'Usage: dsh-codex-cu-setup [--install] [--runtime-dir ABSOLUTE_DIR] [--archive PINNED_OFFICIAL_ZIP] [--source-app VERIFIED_APP] [--skip-local] [--force] [--check]\nPrepares official signed Node, full CU runtime and CLI in a private cache. Does not install Codex Desktop, copy accounts, or grant macOS permissions.'
export async function runSetup(args = process.argv.slice(2)): Promise<void> {
  const options: RuntimeOptions = {
    archivePath: process.env.DSH_CODEX_CU_ARCHIVE,
    sourceApp: process.env.DSH_CODEX_CU_SOURCE_APP,
    skipLocal: process.env.DSH_CODEX_CU_SKIP_LOCAL === '1',
    log: message => console.error('[dsh-codex-cu] ' + message),
  }
  let check = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') { console.log(usage); return }
    if (arg === '--install') continue
    else if (arg === '--runtime-dir' && args[i + 1]) options.runtimeDir = args[++i]
    else if (arg === '--archive' && args[i + 1]) options.archivePath = args[++i]
    else if (arg === '--source-app' && args[i + 1]) options.sourceApp = args[++i]
    else if (arg === '--skip-local') options.skipLocal = true
    else if (arg === '--force') options.force = true
    else if (arg === '--check') check = true
    else throw new Error(usage)
  }
  if (check) {
    const paths = readPreparedRuntime(options.runtimeDir)
    console.log(JSON.stringify({ prepared: !!paths, verification: 'metadata-only; use doctor for verified live checks', ...paths }, null, 2))
    process.exitCode = paths ? 0 : 1
    return
  }
  const abort = new AbortController()
  options.signal = abort.signal
  const interrupt = () => { process.exitCode = 130; abort.abort() }
  const terminate = () => { process.exitCode = 143; abort.abort() }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    const paths = await ensureRuntime(options)
    console.log(JSON.stringify({ prepared: true, ...paths, accountFilesCopied: false, macOSPermissions: 'user-controlled; not granted by this installer' }, null, 2))
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSetup().catch(error => { console.error(error instanceof Error ? error.message : 'Codex CU setup failed.'); process.exitCode ||= 1 })
}
