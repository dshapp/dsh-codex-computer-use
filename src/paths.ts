import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

export const CLIENT_RELATIVE_PATH = 'Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'
export const SERVER_NAME = 'codex_cu'

export interface PathOptions {
  appPath?: string
  codexHome?: string
  home?: string
}

/** Resolve per-user installations; never shell-expand or execute configuration. */
export function resolveAppPath(options: PathOptions = {}): string {
  const home = options.home ?? homedir()
  const app = options.appPath || join(options.codexHome || join(home, '.codex'), 'computer-use', 'Codex Computer Use.app')
  if (!isAbsolute(app)) throw new Error('Codex CU appPath and CODEX_HOME must resolve to an absolute path (do not use ~).')
  return normalize(app)
}

export function resolveClientPath(options: PathOptions = {}): string {
  return join(resolveAppPath(options), CLIENT_RELATIVE_PATH)
}

export function assertClientExecutable(command: string): void {
  try {
    if (!statSync(command).isFile()) throw new Error('Not a file')
    accessSync(command, constants.X_OK)
  } catch {
    throw new Error('Codex CU client is missing or not executable: ' + command + '. Install Codex Computer Use through the official app, or set appPath. This plugin does not install or modify OpenAI software.')
  }
}
