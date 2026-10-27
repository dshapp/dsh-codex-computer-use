#!/usr/bin/env node
import { diagnose } from './diagnostics.ts'
import { prepareLaunch, resolveLaunchSpec, type LaunchOptions } from './launch-config.ts'

const usage = 'Usage: dsh-codex-cu-doctor [--runtime-dir ABSOLUTE_DIR] [--no-setup] [--direct] [--app-path ABSOLUTE_APP_PATH] [--node-path SIGNED_NODE] [--cli-path CODEX_CLI] [--codex-home ABSOLUTE_DIR] [--timeout-ms 15000]\nRead-only MCP discovery and list_apps probe. Default uses the official signed Node launch chain; no desktop input.'

async function main(): Promise<void> {
  const options: LaunchOptions = {}
  let timeoutMs = 15_000
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--help' || flag === '-h') { console.log(usage); return }
    if (flag === '--runtime-dir' && args[i + 1]) options.runtimeDir = args[++i]
    else if (flag === '--no-setup') options.autoSetup = false
    else if (flag === '--direct') options.mode = 'direct'
    else if (flag === '--app-path' && args[i + 1]) options.appPath = args[++i]
    else if (flag === '--node-path' && args[i + 1]) options.nodePath = args[++i]
    else if (flag === '--cli-path' && args[i + 1]) options.cliPath = args[++i]
    else if (flag === '--codex-home' && args[i + 1]) options.codexHome = args[++i]
    else if (flag === '--timeout-ms' && args[i + 1]) timeoutMs = Number(args[++i])
    else throw new Error(usage)
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('--timeout-ms must be an integer between 1 and 600000.')
  if (process.platform !== 'darwin') throw new Error('Codex CU diagnostic must run on macOS.')
  await prepareLaunch(options, message => console.error('[dsh-codex-cu] ' + message))
  const launch = resolveLaunchSpec(options)
  const report = await diagnose({ ...launch, timeoutMs })
  console.log(JSON.stringify({ launchMode: options.mode || 'signed-node', command: launch.command, ...report }, null, 2))
  process.exitCode = report.status === 'read-only-call-ok' ? 0 : 1
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Codex CU diagnostic failed.')
  process.exitCode = 1
})
