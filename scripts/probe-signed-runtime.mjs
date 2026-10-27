import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { homedir } from 'node:os'
import { join } from 'node:path'
class OwnedTransport extends StdioClientTransport { closing; close() { return this.closing ??= super.close() } }
const transport = new OwnedTransport({command:join(homedir(),'.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'),args:['mcp'],env:scrubbedParentEnv(),stderr:'pipe'})
transport.stderr.on('data',()=>{})
const client = new Client({name:'dsh-codex-cu-auth-probe',version:'0.1.0'},{capabilities:{elicitation:{form:{}}}})
// Finder-only access explicitly approved by the user in this session.
client.setRequestHandler(ElicitRequestSchema, async request => {
 if (process.argv[2] === 'com.apple.finder' && request.params.message === 'Allow ChatGPT to use Finder?' && Object.keys(request.params.requestedSchema?.properties || {}).length === 0) return {action:'accept',content:{}}
 return {action:'decline'}
})
const signal = AbortSignal.timeout(15000)
try {
 await client.connect(transport,{signal,timeout:15000})
 const protocolHandler = transport.onmessage
 transport.onmessage = message => {
  if (message.method && message.id !== undefined) console.error(JSON.stringify({incomingServerRequest:message.method,paramKeys:Object.keys(message.params || {}),message:message.params?.message,requestedSchema:message.params?.requestedSchema,metaKeys:Object.keys(message.params?._meta || {})}))
  protocolHandler?.(message)
 }
 const result = await client.callTool({name:'list_apps',arguments:{}},undefined,{signal,timeout:15000})
 console.log(JSON.stringify(result.isError ? result : {tool:'list_apps',isError:false,contentTypes:result.content.map(c=>c.type),textLengths:result.content.filter(c=>c.type==='text').map(c=>c.text.length)},null,2))
 if (!result.isError && process.argv[2]) {
   const state = await client.callTool({name:'get_app_state',arguments:{app:process.argv[2]}},undefined,{signal:AbortSignal.timeout(60000),timeout:60000})
   console.log(JSON.stringify(state.isError?state:{tool:'get_app_state',app:process.argv[2],isError:false,contentTypes:state.content.map(c=>c.type),images:state.content.filter(c=>c.type==='image').map(c=>({mimeType:c.mimeType,bytes:Buffer.from(c.data,'base64').length})),textLengths:state.content.filter(c=>c.type==='text').map(c=>c.text.length),rawContentsOmitted:true},null,2))
 }
} catch (error) { console.log(JSON.stringify({error:String(error),code:error.code})) }
finally { try { await client.close() } finally { await transport.close() } }
