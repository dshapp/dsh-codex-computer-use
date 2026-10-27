/** Real production-package postinstall using the pinned public ZIP downloaded locally.
 * Does not read accounts or interact with apps; leaves verified runtime cache reusable. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = resolve(import.meta.dirname, '..')
const download = process.argv.includes('--download')
const archive = download ? '' : process.env.DSH_CODEX_CU_ARCHIVE
if (!archive && !download) throw Error('Set DSH_CODEX_CU_ARCHIVE to the pinned official ZIP, or use --download')
const dir = mkdtempSync(join(tmpdir(), 'dsh-codex-cu-postinstall-'))
function run(command,args,cwd=dir,env={}) {
 const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:900000,maxBuffer:8*1024*1024,env:{...process.env,...env}})
 if(result.error||result.status!==0) throw Error(command+' failed: '+(result.error?.message||result.stderr||result.stdout))
 return result.stdout
}
try {
 const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',dir],root))
 writeFileSync(join(dir,'package.json'),JSON.stringify({name:'codex-cu-real-bootstrap-test',private:true,type:'module'}))
 const stdout=run('npm',['install','--omit=dev','--foreground-scripts','--no-audit','--no-fund',join(dir,packed[0].filename)],dir,{DSH_CODEX_CU_SKIP_SETUP:'0',DSH_CODEX_CU_SKIP_LOCAL:'1',DSH_CODEX_CU_ARCHIVE:archive || ''})
 console.log(stdout)
 const output=run(process.execPath,[join(dir,'node_modules/.bin/dsh-codex-cu-setup'),'--check'])
 const report=JSON.parse(output)
 if(!report.prepared||[report.nodePath,report.cliPath,report.appPath].some(p=>p.startsWith('/Applications/'))) throw Error('Installed package is not using private prepared runtime')
 console.log(JSON.stringify({postinstallCompleted:true,ordinaryProductionInstall:true,defaultDownloadRequested:download,noPreinstalledCodexPaths:true,readiness:report.verification,paths:{nodePath:report.nodePath,cliPath:report.cliPath,appPath:report.appPath,codexHome:report.codexHome},accountFilesCopied:false},null,2))
} finally { rmSync(dir,{recursive:true,force:true}) }
