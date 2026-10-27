import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as Bootstrap from '../src/bootstrap.ts'
import { prepareLaunch, resolveLaunchSpec } from '../src/launch-config.ts'
import { CLIENT_RELATIVE_PATH } from '../src/paths.ts'
const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function prepared(): Bootstrap.RuntimePaths {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codex-cu-launch-bootstrap-')); dirs.push(root)
  const releaseDir = join(root, 'versions', 'fixture'), codexHome = join(releaseDir, 'home')
  const appPath = join(codexHome, 'computer-use', 'Codex Computer Use.app'), clientPath = join(appPath, CLIENT_RELATIVE_PATH)
  mkdirSync(dirname(clientPath), { recursive: true }); writeFileSync(clientPath, '', { mode: 0o755 })
  return { root, releaseDir, codexHome, appPath, clientPath, nodePath: process.execPath, cliPath: process.execPath }
}
describe('installation and first-start integration', () => {
  it('prepares missing dependencies on default plugin startup even if lifecycle scripts were skipped', async () => {
    const paths = prepared(), ensure = vi.spyOn(Bootstrap, 'ensureRuntime').mockResolvedValue(paths)
    const log = vi.fn(), signal = new AbortController().signal
    await prepareLaunch({ runtimeDir: paths.root }, log, signal)
    expect(ensure).toHaveBeenCalledWith({ runtimeDir: paths.root, log, signal })
  })
  it('does not auto-download for complete explicit configuration, direct diagnostics or opt-out', async () => {
    const ensure = vi.spyOn(Bootstrap, 'ensureRuntime').mockResolvedValue(prepared())
    await prepareLaunch({ appPath: '/custom/app', nodePath: '/custom/node', cliPath: '/custom/cli' })
    await prepareLaunch({ mode: 'direct' })
    await prepareLaunch({ autoSetup: false })
    expect(ensure).not.toHaveBeenCalled()
  })
  it('selects prepared private paths without relying on a Codex desktop installation', () => {
    const paths = prepared(), read = vi.spyOn(Bootstrap, 'readPreparedRuntime').mockReturnValue(paths)
    const launch = resolveLaunchSpec({ runtimeDir: paths.root })
    expect(read).toHaveBeenCalledWith(paths.root)
    expect(launch.command).toBe(paths.nodePath)
    expect(launch.args[1]).toBe(paths.clientPath)
    expect(launch.env.CODEX_HOME).toBe(paths.codexHome)
    expect(launch.env.CODEX_CLI_PATH).toBe(paths.cliPath)
    expect(launch.env.SKY_CUA_SERVICE_PATH).toBe(paths.appPath)
    expect(JSON.stringify(launch)).not.toContain('/Applications/')
  })
  it('retains explicit user overrides rather than replacing them with cached defaults', () => {
    const paths = prepared(); vi.spyOn(Bootstrap, 'readPreparedRuntime').mockReturnValue(paths)
    const launch = resolveLaunchSpec({ appPath: paths.appPath, codexHome: '/explicit/home', nodePath: process.execPath, cliPath: process.execPath, permissionMode: 'deny' })
    expect(launch.env.CODEX_HOME).toBe('/explicit/home')
    expect(launch.env.DSH_CODEX_CU_PERMISSION_MODE).toBe('deny')
  })
})
