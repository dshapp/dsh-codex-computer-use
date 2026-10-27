/** Real Finder-only state test, explicitly authorized by the user. No GUI input. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { createMcpConfig } from '../lib/index.js'
class Owned extends StdioClientTransport { closing; close() { return this.closing ??= super.close() } }
const config = createMcpConfig({ appPath:'', toolCallTimeoutMs:60000, allowedApps:['Finder'], permissionMode:'deny' })
const transport = new Owned({command:config.command,args:config.args,cwd:config.cwd,env:{...scrubbedParentEnv(),...config.env},stderr:'pipe'})
transport.stderr.on('data',()=>{})
const client = new Client({name:'dsh-codex-cu-window-verification',version:'0.1.0'})
try {
 await client.connect(transport,{signal:AbortSignal.timeout(15000),timeout:15000})
 const result = await client.callTool({name:'get_app_state',arguments:{app:'com.apple.finder'}},undefined,{signal:AbortSignal.timeout(60000),timeout:60000})
 const images = (result.content || []).filter(c=>c.type==='image').map(c=>{const bytes=Buffer.from(c.data,'base64');return{mimeType:c.mimeType,bytes:bytes.length,jpegHeaderValid:c.mimeType==='image/jpeg'&&bytes[0]===255&&bytes[1]===216}})
 console.log(JSON.stringify({route:'ordinary Node SDK -> signed Node permission proxy -> official CU',app:'com.apple.finder',isError:!!result.isError,contentTypes:(result.content||[]).map(c=>c.type),images,axTextChars:(result.content||[]).filter(c=>c.type==='text').reduce((n,c)=>n+c.text.length,0),rawContentsOmitted:true,error:result.isError?result.content:undefined},null,2))
 process.exitCode = !result.isError && images.some(i=>i.jpegHeaderValid)?0:1
} finally { try { await client.close() } finally { await transport.close() } }
