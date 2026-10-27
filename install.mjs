/** npm lifecycle entry: shipped JS, no build tool or preinstalled Codex needed. */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
if (process.env.DSH_CODEX_CU_SKIP_SETUP === '1') {
  console.error('[dsh-codex-cu] Runtime setup skipped explicitly; first DSH use will prepare it unless autoSetup=false.')
} else if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('[dsh-codex-cu] Automatic runtime preparation currently supports macOS Apple Silicon only.')
} else if (!existsSync(fileURLToPath(new URL('./lib/setup.js', import.meta.url)))) {
  console.error('[dsh-codex-cu] Source checkout needs npm run build first. Packaged installs and first DSH startup prepare the runtime automatically.')
} else {
  try {
    const { runSetup } = await import('./lib/setup.js')
    await runSetup(['--install'])
  } catch (error) {
    console.error('[dsh-codex-cu] Runtime preparation failed: ' + (error instanceof Error ? error.message : 'unknown error'))
    console.error('[dsh-codex-cu] Fix network/disk access and retry dsh-codex-cu-setup, or retry installation. No incomplete runtime was marked ready.')
    process.exitCode ||= 1
  }
}
