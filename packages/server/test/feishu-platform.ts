import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'

// The small subset of Feishu's protobuf frame format used by its real WSClient.
function integer(value: number) { const bytes:number[]=[]; do { const next=value&127; value=Math.floor(value/128); bytes.push(next | (value ? 128 : 0)) } while(value); return Buffer.from(bytes) }
function numberField(field:number,value:number) { return Buffer.concat([integer(field*8),integer(value)]) }
function bytesField(field:number,value:Uint8Array|string) { const bytes=typeof value==='string'?Buffer.from(value):Buffer.from(value); return Buffer.concat([integer(field*8+2),integer(bytes.length),bytes]) }
function fields(buffer:Buffer) {
  let at=0
  const read=()=>{let n=0,shift=0,b=0; do { b=buffer[at++]!; n+=(b&127)*2**shift;shift+=7 } while(b&128);return n}
  const result:{field:number;value:number|Buffer}[]=[]
  while(at<buffer.length) {const tag=read(),wire=tag&7,field=tag>>>3;if(wire===0)result.push({field,value:read()});else if(wire===2){const n=read();result.push({field,value:buffer.subarray(at,at+n)});at+=n}else throw new Error('unsupported protobuf wire')}
  return result
}
function frame(id:number,payload:unknown) {
  const headers={message_id:'frame-'+id,sum:'1',seq:'0',type:'event',trace_id:'trace-'+id}
  return Buffer.concat([numberField(1,id),numberField(2,id),numberField(3,1),numberField(4,1),...Object.entries(headers).map(([k,v])=>bytesField(5,Buffer.concat([bytesField(1,k),bytesField(2,v)]))),bytesField(8,JSON.stringify(payload))])
}
export interface Sent { id:string; type:string; content:string; replyTo?:string; uuid?:string }
export async function feishuPlatform() {
  const sent:Sent[]=[], patches:{id:string;content:string;at:number}[]=[], uploads:{type:string;body:Buffer}[]=[], calls:string[]=[]
  const messages=new Map<string,Record<string,unknown>>(), receipts=new Map<string,string>(), sockets:WebSocket[]=[]
  const state={ failSends:false, downloads:0, handshake:0 }
  let origin='', sequence=0
  const pending=new Map<number,{resolve:(code:number)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>()
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url!,origin);calls.push(req.method+' '+url.pathname+url.search)
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const bytes=Buffer.concat(chunks)
    const json=(value:unknown,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}
    if(url.pathname==='/callback/ws/endpoint'){state.handshake++;return json({code:0,data:{URL:origin.replace('http','ws')+'/ws?device_id=device&service_id=1',ClientConfig:{PingInterval:3600,ReconnectCount:-1,ReconnectInterval:0.1,ReconnectNonce:0}}})}
    if(url.pathname.includes('/auth/v3/tenant_access_token'))return json({code:0,tenant_access_token:'tenant-token',expire:7200})
    if(url.pathname==='/open-apis/bot/v3/info')return json({code:0,bot:{open_id:'bot-open-id',app_name:'Test Bot'}})
    if(url.pathname.includes('/resources/')){state.downloads++;res.writeHead(200,{'content-type':url.searchParams.get('type')==='image'?'image/png':'text/plain'});res.end(url.searchParams.get('type')==='image'?Buffer.from([137,80,78,71,13,10,26,10]):'attached content');return}
    if(url.pathname==='/open-apis/im/v1/images'||url.pathname==='/open-apis/im/v1/files'){const image=url.pathname.endsWith('images');uploads.push({type:image?'image':'file',body:bytes});return json({code:0,data:image?{image_key:'uploaded-image-'+uploads.length}:{file_key:'uploaded-file-'+uploads.length}})}
    const messagePath=/^\/open-apis\/im\/v1\/messages\/([^/]+)(?:\/(reply))?$/.exec(url.pathname)
    if(req.method==='GET'&&url.pathname==='/open-apis/im/v1/messages')return json({code:0,data:{items:[{message_id:'history-1',sender:{id:'group-member'},body:{content:JSON.stringify({text:'earlier thread context'})}}],has_more:false}})
    if(req.method==='GET'&&messagePath)return json({code:0,data:{items:[messages.get(messagePath[1]!)??{message_id:messagePath[1],root_id:'root-message',body:{content:JSON.stringify({text:'quoted message context'})}}]}})
    if((req.method==='POST'&&url.pathname==='/open-apis/im/v1/messages')||(req.method==='POST'&&messagePath?.[2])){
      if(state.failSends)return json({code:999,msg:'temporary failure'},503)
      const data=JSON.parse(bytes.toString()),known=receipts.get(data.uuid)
      if(known)return json({code:0,data:{message_id:known}})
      const id='out-'+(sent.length+1);sent.push({id,type:data.msg_type,content:data.content,...(messagePath?.[2]&&{replyTo:messagePath[1]}),uuid:data.uuid});receipts.set(data.uuid,id)
      return json({code:0,data:{message_id:id}})
    }
    if(req.method==='PATCH'&&messagePath){if(state.failSends)return json({code:999,msg:'temporary failure'},503);const data=JSON.parse(bytes.toString());patches.push({id:messagePath[1]!,content:data.content,at:Date.now()});const prior=sent.find(m=>m.id===messagePath[1]);if(prior)prior.content=data.content;return json({code:0,data:{}})}
    json({code:404,msg:'unimplemented '+url.pathname},404)
  })
  const wss=new WebSocketServer({server})
  wss.on('connection',socket=>{sockets.push(socket);socket.on('message',buffer=>{const decoded=fields(Buffer.from(buffer as Buffer));const id=decoded.find(f=>f.field===1)?.value;const payload=decoded.find(f=>f.field===8)?.value;if(typeof id!=='number'||!Buffer.isBuffer(payload))return;const p=pending.get(id);if(p){clearTimeout(p.timer);pending.delete(id);p.resolve(JSON.parse(payload.toString()).code)}})})
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  return {origin,state,sent,patches,uploads,calls,messages,sockets,
    async event(eventId:string,text:string,options:{actor?:string;group?:boolean;mention?:boolean;thread?:string;parent?:string;root?:string;type?:string;content?:Record<string,unknown>}={}){
      const socket=sockets.findLast(s=>s.readyState===WebSocket.OPEN);if(!socket)throw new Error('no Feishu socket')
      const id=++sequence,messageId='in-'+eventId
      const message={message_id:messageId,chat_id:options.group?'group-chat':'private-chat',chat_type:options.group?'group':'p2p',message_type:options.type??'text',content:JSON.stringify(options.content??{text:(options.mention?'@_bot ':'')+text}),...(options.thread&&{thread_id:options.thread}),...(options.parent&&{parent_id:options.parent}),...(options.root&&{root_id:options.root}),...(options.mention&&{mentions:[{key:'@_bot',id:{open_id:'bot-open-id'},name:'Bot'}]})}
      messages.set(messageId,{...message,body:{content:message.content}})
      const payload={schema:'2.0',header:{event_id:eventId,event_type:'im.message.receive_v1',create_time:String(Date.now()),app_id:'cli_0123456789abcdef'},event:{sender:{sender_type:'user',sender_id:{open_id:options.actor??'owner-open-id'}},message}}
      const ack=new Promise<number>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Feishu ACK timed out'))},10000);pending.set(id,{resolve,reject,timer})});socket.send(frame(id,payload));return ack
    },
    async close(){for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('closed'))};for(const s of sockets)s.terminate();await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()))},
  }
}
