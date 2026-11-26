import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { join } from 'node:path'
import { test } from 'node:test'
import { fauxModels, pluginDefaultsFromEnv, UserSpace } from '../src/index.ts'
import { feishuPlatform } from './feishu-platform.ts'
import { diskEnv } from './fixtures.ts'
import { fakeUpstream, pluginEnv, tempDir } from './host-helpers.ts'

async function until(check:()=>Promise<boolean>|boolean, timeout=10000){const end=Date.now()+timeout;while(!(await check())){if(Date.now()>end)throw new Error('Feishu state timed out');await new Promise(r=>setTimeout(r,20))}}
async function done(space:UserSpace,id:string){await until(async()=>!!(await space.db.get<{receipt:string|null}>('SELECT receipt FROM outbox WHERE id = ?',id+':final'))?.receipt)}
const textOf=(content:string)=>JSON.parse(content).elements.map((e:{content?:string})=>e.content??'').join('\n')
const config={enabled:true,values:{appId:'cli_0123456789abcdef'},secrets:{appSecret:'private-feishu-secret'}}

async function setup(){
  const remote=await feishuPlatform(),upstream=await fakeUpstream(),root=await tempDir(),env=await diskEnv(root)
  const options={models:fauxModels(),env,secretKey:'key',plugins:{defaults:pluginDefaultsFromEnv(pluginEnv(upstream.url))},feishu:{domain:remote.origin,publicUrl:'https://gense.example'},outboxRetryMs:50}
  const space=await UserSpace.open(await openNodeSqliteDatabase(join(root,'feishu.sqlite')),options)
  await space.channels.set('feishu',config)
  return {remote,upstream,root,env,options,space,async pair(){const {code}=await space.channels.pair('feishu');assert.equal(await remote.event('pair',code),200);await done(space,'pair')},async close(){await space.close();await remote.close();await upstream.close()}}
}

test('N2/N3/N4/N6: Feishu HTTP + protobuf WebSocket pairing, denied actors, one streaming card, duplicate delivery and shared web transcript',async()=>{
  const fixture=await setup(),{space,remote}=fixture
  try{
    assert.equal(space.channels.list().find(c=>c.id==='feishu')!.status,'ready')
    assert.equal(await remote.event('stranger','do not run',{actor:'stranger'}),200)
    assert.equal((await space.triggers.get('stranger'))!.decision,'rejected')
    assert.equal((await space.trees()).length,0)
    const expired=await space.channels.pair('feishu');await space.db.run('UPDATE channel_pairs SET expires_at = 0')
    await remote.event('expired',expired.code)
    assert.equal((await space.triggers.get('expired'))!.decision,'rejected')
    await fixture.pair()
    assert.equal((await space.trees()).length,0)
    const before=remote.sent.length
    assert.equal(await remote.event('long','[长回答] stream'),200)
    await done(space,'long')
    assert.equal(remote.sent.length,before+1,'stream and final occupy one card')
    const card=remote.sent.at(-1)!,updates=remote.patches.filter(p=>p.id===card.id)
    assert.ok(updates.length>=2)
    assert.match(textOf(card.content),/第 300 句/)
    assert.equal(JSON.parse(card.content).header.title.content,'Gense')
    const progress=updates.filter(p=>JSON.parse(p.content).header.title.content.includes('回答中'))
    for(let i=1;i<progress.length;i++)assert.ok(progress[i]!.at-progress[i-1]!.at>=850,'progress is throttled around one second')
    await remote.event('long','[长回答] stream');await new Promise(r=>setTimeout(r,50));assert.equal(remote.sent.length,before+1)
    const tree=(await space.trees())[0]!
    assert.equal(tree.source?.kind,'feishu')
    const {watch}=await space.watch(tree.id);await watch.stop()
    assert.equal(watch.value.entries.filter(e=>e.kind==='pi.user').length,1)
    assert.equal(watch.value.entries.filter(e=>e.kind==='pi.assistant').length,1)
    await space.send(tree.id,{text:'from browser',requestId:'browser-followup'});await space.harness.waitForIdle(ctx);await space.outbox.drain();assert.equal(remote.sent.length,before+1)
    const row=await space.db.get<{secrets:string}>('SELECT secrets FROM channels WHERE id = ?', 'feishu');assert.ok(!row!.secrets.includes('private-feishu-secret'))
    assert.ok(!JSON.stringify(space.channels.list()).includes('private-feishu-secret'))
    remote.sockets.at(-1)!.terminate();await until(()=>remote.state.handshake>=2&&remote.sockets.at(-1)!.readyState===1)
    await remote.event('after-reconnect','hello');await done(space,'after-reconnect')
    assert.equal((await space.trees()).length,1)
  }finally{await fixture.close()}
})

test('N5/N7: only group @Bot runs, thread and quoted context are included; commands create, select models and abort without model inputs',async()=>{
  const fixture=await setup(),{space,remote}=fixture
  try{
    await fixture.pair()
    await remote.event('ignored','not mentioned',{group:true,thread:'topic'})
    assert.equal((await space.triggers.get('ignored'))!.decision,'rejected')
    assert.match((await space.triggers.list('feishu'))[0]!.reason!,/@Bot/)
    assert.equal((await space.trees()).length,0)
    await remote.event('group-one','first',{group:true,mention:true,thread:'topic',parent:'quoted'})
    await done(space,'group-one')
    const threadTree=await space.triggers.thread('feishu','group-chat:topic')
    assert.ok(threadTree)
    const {watch}=await space.watch(threadTree!);await watch.stop()
    const user=watch.value.entries.find(e=>e.kind==='pi.user')!
    assert.match(JSON.stringify(user.model),/quoted message context/);assert.match(JSON.stringify(user.model),/earlier thread context/)
    assert.equal(remote.sent.at(-1)!.replyTo,'in-group-one')
    await remote.event('group-two','second',{group:true,mention:true,thread:'topic'});await done(space,'group-two')
    assert.equal(await space.triggers.thread('feishu','group-chat:topic'),threadTree)
    await remote.event('fallback-one','root',{group:true,mention:true,parent:'quoted'});await done(space,'fallback-one')
    await remote.event('fallback-two','root again',{group:true,mention:true,parent:'another-quoted'});await done(space,'fallback-two')
    assert.equal((await space.triggers.get('fallback-one'))!.tree_id,(await space.triggers.get('fallback-two'))!.tree_id)
    await remote.event('help','/help');await done(space,'help');assert.match(textOf(remote.sent.at(-1)!.content),/\/new/)
    await remote.event('new','/new');await done(space,'new')
    const privateTree=await space.triggers.thread('feishu','private-chat')
    assert.ok(privateTree)
    await remote.event('model','/model');await done(space,'model');assert.match(textOf(remote.sent.at(-1)!.content),/faux-1/)
    await remote.event('model-set','/model faux-1');await done(space,'model-set');assert.match(textOf(remote.sent.at(-1)!.content),/已切换/)
    await remote.event('model-bad','/model nonexistent');await done(space,'model-bad');assert.match(textOf(remote.sent.at(-1)!.content),/不可用/)
    const {watch:empty}=await space.watch(privateTree!);await empty.stop();assert.equal(empty.value.entries.filter(e=>e.kind==='pi.user').length,0)
    await remote.event('slow','[长回答] stop me');await until(()=>remote.sent.some(s=>JSON.parse(s.content).header?.title?.content.includes('回答中')))
    await remote.event('stop','/stop');await done(space,'stop');await done(space,'slow')
    const {watch:stopped}=await space.watch(privateTree!);await stopped.stop();assert.equal(stopped.value.entries.filter(e=>e.kind==='pi.user').length,1)
    assert.ok((await space.triggers.list('feishu')).some(t=>t.decision==='command'&&t.text==='/stop'))
  }finally{await fixture.close()}
})

test('N8/N9: real image/file downloads enter attachments; generated files/images upload back and rich tools get a web link',async()=>{
  const fixture=await setup(),{space,remote}=fixture
  try{
    await fixture.pair()
    await remote.event('file','',{type:'file',content:{file_key:'file-key',file_name:'document.txt'}});await done(space,'file')
    await remote.event('image','',{type:'image',content:{image_key:'image-key'}});await done(space,'image')
    const tree=(await space.trees())[0]!,files=await space.workspace.list(tree.id)
    assert.ok(files.some(f=>f.path.endsWith('/attachments/document.txt')))
    assert.ok(files.some(f=>f.path.endsWith('/attachments/image-in-image.png')))
    assert.equal(remote.state.downloads,2)
    await remote.event('denied-file','',{actor:'stranger',type:'file',content:{file_key:'never-download',file_name:'bad.txt'}})
    assert.equal(remote.state.downloads,2)
    await remote.event('write-file','[工具 write] {"path":"report.txt","content":"assistant report"}');await done(space,'write-file')
    await until(()=>remote.sent.some(m=>m.type==='file'))
    assert.ok(remote.uploads.find(u=>u.type==='file')!.body.includes(Buffer.from('assistant report')))
    assert.ok(remote.sent.some(m=>m.type==='file'))
    await space.plugins.set('image',{enabled:true})
    await remote.event('generate-image','[工具 image_generate] {"prompt":"one dot"}');await done(space,'generate-image')
    await until(()=>remote.sent.some(m=>m.type==='image'))
    assert.ok(remote.sent.some(m=>m.type==='image'))
    await space.plugins.set('artifact',{enabled:true})
    await remote.event('artifact','[工具 artifact_create] {"title":"Result","type":"markdown","content":"# Result"}');await done(space,'artifact')
    const card=remote.sent.findLast(m=>m.type==='interactive')!
    assert.match(textOf(card.content),/界面或产物/);assert.match(textOf(card.content),new RegExp('https://gense.example/c/'+tree.id))
    const {watch}=await space.watch(tree.id);await watch.stop()
    assert.ok(watch.value.entries.some(e=>JSON.stringify(e.model).includes('artifact_create')))
    assert.ok((await space.workspace.list(tree.id)).some(f=>f.path.endsWith('/report.txt')))
    // An embed with <…> and a link with #page=N both send the files; the card shows the embed as text, not a broken image.
    const imagesBefore=remote.sent.filter(m=>m.type==='image').length,filesBefore=remote.sent.filter(m=>m.type==='file').length
    await remote.event('embed','![发票](<attachments/image-in-image.png>) 见 [第 2 页](attachments/document.txt#page=2)');await done(space,'embed')
    await until(()=>remote.sent.filter(m=>m.type==='image').length>imagesBefore&&remote.sent.filter(m=>m.type==='file').length>filesBefore)
    const embedCard=remote.sent.findLast(m=>m.type==='interactive')!
    assert.match(textOf(embedCard.content),/（图：发票）/);assert.doesNotMatch(textOf(embedCard.content),/!\[/)
  }finally{await fixture.close()}
})

test('N6: SIGKILL after final queueing recovers one Feishu delivery and rejects redelivery after restart',{timeout:30000},async()=>{
  const {fork}=await import('node:child_process')
  const fixture=await setup(),{remote,root,env,upstream}=fixture
  let worker:ReturnType<typeof fork>|undefined,reopened:UserSpace|undefined
  let originalClosed=false
  try{
    await fixture.pair()
    await fixture.space.channels.set('feishu',{values:{stream:false}})
    await fixture.space.close();originalClosed=true
    remote.state.failSends=true
    worker=fork(new URL('./feishu-worker.ts',import.meta.url),[root,remote.origin],{execArgv:[],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,NODE_NO_WARNINGS:'1'},stdio:['ignore','ignore','inherit','ipc']})
    const [ready]=await once(worker,'message');assert.equal(ready.ready,true)
    assert.equal(await remote.event('crash-final','survive the crash'),200)
    await until(async()=>{const response=once(worker!,'message');worker!.send({id:'crash-final'});const [message]=await response;return message.pending===true})
    const stopped=once(worker,'exit');worker.kill('SIGKILL');await stopped;worker=undefined
    const count=remote.sent.length
    remote.state.failSends=false
    reopened=await UserSpace.open(await openNodeSqliteDatabase(join(root,'feishu.sqlite')),{models:fauxModels(),env,secretKey:'key',feishu:{domain:remote.origin,publicUrl:'https://gense.example'},outboxRetryMs:50})
    await done(reopened,'crash-final')
    assert.equal(remote.sent.length,count+1)
    assert.match(textOf(remote.sent.at(-1)!.content),/survive the crash/)
    await remote.event('crash-final','survive the crash');await new Promise(r=>setTimeout(r,100));assert.equal(remote.sent.length,count+1)
    const tree=(await reopened.trees())[0]!,{watch}=await reopened.watch(tree.id);await watch.stop()
    assert.equal(watch.value.entries.filter(e=>e.kind==='pi.user').length,1)
    assert.equal(watch.value.entries.filter(e=>e.kind==='pi.assistant').length,1)
  }finally{
    worker?.kill('SIGKILL');if(reopened)await reopened.close();if(!originalClosed)await fixture.space.close();await remote.close();await upstream.close()
  }
})
