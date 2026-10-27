/** Opt-in real list_apps verification through a keyless DSH composition.
 * Does not install into or modify an existing user profile. */
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as Adapter from '../lib/index.js'
import * as Skills from '../lib/skills.js'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const patches = loadOverlayPatches('codex-cu-local-verification', join(root, 'cordis.patch.yml'))
patches[0].insert[0].name = 'cordis:codex-cu-local-adapter'
patches[0].insert[1].name = 'cordis:codex-cu-local-skills'
let ctx
try {
 ctx = await boot('codex-cu-local-verification', join(root, 'tests/fixtures/base.cordis.yml'), patches, ctx => {
  ctx.loader.builtins['codex-cu-test-system-prompt'] = SystemPrompt
  ctx.loader.builtins['codex-cu-test-tools'] = ToolRegistry
  ctx.loader.builtins['codex-cu-test-skills'] = SkillRegistry
  ctx.loader.builtins['codex-cu-local-adapter'] = Adapter
  ctx.loader.builtins['codex-cu-local-skills'] = Skills
 })
 const deadline = Date.now() + 15000
 while (!ctx.tools.schemas().some(s=>s.name==='mcp__codex_cu__list_apps')) {
  if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous DSH MCP tool registration')
  await new Promise(resolve=>setTimeout(resolve,25))
 }
 const tools = ctx.tools.schemas().filter(s=>s.name.startsWith('mcp__codex_cu__'))
 const result = await ctx.tools.execute({callId:'codex-cu-local-list-apps',name:'mcp__codex_cu__list_apps',arguments:{},signal:AbortSignal.timeout(20000)})
 console.log(JSON.stringify({route:'DSH Cordis Loader -> adapter -> generic MCP bridge -> signed Node relay -> official SkyComputerUseClient',toolCount:tools.length,skillRegistered:(await ctx.skills.list()).some(s=>s.name==='codex-computer-use'),isError:result.isError,successfulContentTypes:result.isError?[]:result.content.map(c=>c.type),error:result.isError?result.error:undefined,appListOmitted:true},null,2))
 process.exitCode = result.isError?1:0
} finally { if (ctx) await ctx.fiber.dispose() }
