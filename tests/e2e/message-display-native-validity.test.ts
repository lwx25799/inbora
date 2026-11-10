import {afterAll,beforeAll,expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {inspectMessageShare} from '../../src/adapters/message-share.js';
import {saveMessagePreviews} from '../../src/adapters/message-preview.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

const witness='EXACT SAVED BODY [微笑]';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=','base64');
let root:string,server:Awaited<ReturnType<typeof fixtureServer>>,owner:BrowserProfileOwner;
beforeAll(async()=>{
  root=privateTemp('display-native-validity-');server=await fixtureServer();owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
});
afterAll(async()=>{await owner?.close();await server?.close();});

test.each([
  {name:'empty native string',native:'',preserve:true},
  {name:'whitespace-only native string',native:' \t\r\n ',preserve:true},
  {name:'over-limit native string',native:'x'.repeat(10_001),preserve:true},
  {name:'native string with forbidden C0',native:'different\u0000body',preserve:true},
  {name:'native string with DEL',native:'different\u007fbody',preserve:true},
  {name:'valid nonempty native contradiction',native:'DIFFERENT VALID NATIVE BODY',preserve:false},
])('$name is distinct from an exact display-text contradiction',async spec=>{
  await mountObserved(owner,server.origin);const mapping=observedMapping(server.origin),at=Date.now()-1000;
  await owner.dm.evaluate(({at,witness})=>{
    const chat=document.querySelector('#chat')!,first=chat.querySelector('.box')!;
    for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
    const row=first.querySelector('.message')!;row.innerHTML='<span class="text"></span><img width="16" height="16" alt="unknown">';
    row.querySelector('.text')!.textContent=witness;
    const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
    native.serverId='99891';native.type=7;native.createdAt=new Date(at);native._parsedContent.text=witness;
  },{at,witness});
  const input={mapping,channel:'dm' as const,index:0,evidenceId:'synthetic-native-validity',peer:mapping.peers[0]!,dmWindow:true};
  const batch=await owner.dm.evaluate(captureObserved,input),event=batch.events[0]!,original=JSON.stringify(event),cache=new MessagePreviewStore(root);
  const prior=await owner.dm.evaluate(inspectMessageShare,{mapping,event,peer:mapping.peers[0]!});
  expect(prior.displayText).toBe(witness);expect(event.observationIssue).toBe('DM_CONTENT_UNVERIFIED');
  cache.save(event,mapping.self.uid,[{label:'existing image',png}]);cache.saveDisplayText(event,mapping.self.uid,prior.displayText!);
  const images=cache.list(event,mapping.self.uid);expect(images[0]?.state).toBe('READY');
  await owner.dm.locator('.message').evaluate((row,nativeText)=>{
    const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
    native._parsedContent.text=nativeText;
  },spec.native);
  const current=await owner.dm.evaluate(inspectMessageShare,{mapping,event,peer:mapping.peers[0]!});
  expect(current.diagnostic.calibration?.text.bodyReconstructed).toBe(true);
  expect(current.diagnostic.calibration?.text.bodyNonEmpty).toBe(true);
  await saveMessagePreviews(owner.dm,mapping,batch,root,new AbortController().signal,mapping.peers[0]);
  expect(cache.displayText(event,mapping.self.uid)).toBe(spec.preserve?witness:null);
  expect(Object.hasOwn(current,'displayText')).toBe(!spec.preserve);
  expect(cache.list(event,mapping.self.uid)).toEqual(images);expect(JSON.stringify(event)).toBe(original);
});
