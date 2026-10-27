/** Empty CODEX_HOME probe. Does not copy credentials or inspect app contents. */
import { mkdtempSync, rmSync, cpSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { createMcpConfig } from '../lib/index.js'
class Owned extends StdioClientTransport { closing; close() { return this.closing ??= super.close() } }
const home = mkdtempSync(join(tmpdir(),'dsh-codex-cu-clean-home-'))
const prepared=createMcpConfig({appPath:'',toolCallTimeoutMs:15000,permissionMode:'deny'})
if ([prepared.command,prepared.env.CODEX_CLI_PATH,prepared.env.SKY_CUA_SERVICE_PATH].some(p=>p.startsWith('/Applications/'))) throw Error('This validation requires the private prepared runtime')
const app=join(home,'computer-use/Codex Computer Use.app')
mkdirSync(join(home,'computer-use'),{recursive:true})
cpSync(prepared.env.SKY_CUA_SERVICE_PATH,app,{recursive:true})
const config = createMcpConfig({appPath:app,codexHome:home,nodePath:prepared.command,cliPath:prepared.env.CODEX_CLI_PATH,toolCallTimeoutMs:15000,permissionMode:'deny'})
const transport = new Owned({command:config.command,args:config.args,cwd:config.cwd,env:{...scrubbedParentEnv(),...config.env},stderr:'pipe'})
transport.stderr.on('data',()=>{})
const client = new Client({name:'dsh-codex-cu-clean-home-test',version:'0.1.0'})
try {
 await client.connect(transport,{signal:AbortSignal.timeout(15000),timeout:15000})
 const result=await client.callTool({name:'list_apps',arguments:{}},undefined,{signal:AbortSignal.timeout(20000),timeout:20000})
 console.log(JSON.stringify(result.isError?{codexHomeInitiallyEmpty:true,managedExecutablesOnly:true,isError:true,error:result.content}:{codexHomeInitiallyEmpty:true,managedExecutablesOnly:true,isError:false,contentOmitted:true},null,2))
} finally { try {await client.close()} finally {await transport.close();rmSync(home,{recursive:true,force:true})} }
