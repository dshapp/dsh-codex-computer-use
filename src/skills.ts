/** Skill provider registration follows the KimiCU companion-plugin pattern. */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

export const name = 'codex-computer-use-skills'
export const SKILL_PROVIDER_NAME = 'codex-computer-use'

export function resolveBundledSkillsDir(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('../package.json')), 'skills')
}

export function apply(ctx: Context): void {
  ctx.plugin(SkillFilesystem, {
    providerName: SKILL_PROVIDER_NAME,
    includeDefaultRoots: false,
    customSkillDirs: [resolveBundledSkillsDir()],
  })
}
