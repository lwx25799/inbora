import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureServer } from '../tests/fixtures/site.ts';
import { observedMapping, mountObserved } from '../tests/fixtures/observed-site.ts';

const source = process.argv[2] === 'source', root = source ? 'src' : 'dist';
const moduleUrl = name => pathToFileURL(resolve(root,name.replace(/\.js$/,source?'.ts':'.js'))).href;
const {BrowserProfileOwner} = await import(moduleUrl('browser/profile-owner.js'));
const {ObservedReader} = await import(moduleUrl('adapters/observed-reader.js'));
const {validateObservationMapping} = await import(moduleUrl('config/site-mapping.js'));
const {EventStore} = await import(moduleUrl('storage/store.js'));
const base=resolve('.local/observed-smoke');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'run-'));
const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(dir,'profile'),true);
const store=new EventStore(join(dir,'poc.sqlite'),true,()=> '2026-11-03T00:00:00Z');
try {
  await mountObserved(owner,server.origin);
  // Cover the real opening path: the permitted row is selected before delayed header metadata mounts.
  await owner.dm.evaluate(()=>{
    document.querySelector('#chat').hidden=true; window.opened=0;
    const panel=document.querySelector('#dm-panel'),row=document.querySelector('.conversation');
    panel.style.minHeight='24px';panel.hidden=true;row.remove();
    document.querySelector('#dm-open').addEventListener('click',()=>{
      panel.hidden=false;setTimeout(()=>panel.prepend(row),1200);
    });
    row.addEventListener('click',()=>{
      window.opened++;document.querySelector('#chat').hidden=false;
      const header=document.querySelector('#header'),props=Object.getOwnPropertyDescriptor(header,'__reactProps$fixture').value;
      const conversation=props.children.props.conversation;delete props.children.props.conversation;
      setTimeout(()=>props.children.props.conversation=conversation,120);
    });
  });
  const config=validateObservationMapping(observedMapping(server.origin),false);
  const batch=await owner.actor.run(()=>new ObservedReader(owner.dm,config).dm(0));
  assert.equal(batch.events.length,4);assert.equal(batch.unsupported,1);
  assert.equal(await owner.dm.evaluate(()=>window.opened),1);
  store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture');
  for(let n=0;n<5;n++)store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','fixture');
  assert.equal(store.events().length,3);assert.ok(store.events().every(e=>e.status==='AWAITING_DRAFT'));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM send_intents').get().n,0);
  console.log(JSON.stringify({observedReaderSmoke:'PASS',runtime:source?'tsx-source':'compiled-node',events:3,sends:0}));
} finally {store.close();await owner.close();await server.close();}
