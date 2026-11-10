import {expect,test,vi} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import type {Page} from 'playwright';
import {saveMessagePreviews,inspectMessageImage} from '../../src/adapters/message-preview.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import type {ObservationBatch} from '../../src/adapters/observed-reader.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {candidate,privateTemp} from '../helpers.js';
import {eventBinding} from '../../src/core/contracts.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=','base64');
test.each(['READY','INSPECT_FAILURE','CAPTURE_FAILURE'] as const)('normal preview batches overwrite a bounded body-free diagnostic and preserve failures (%s)',async outcome=>{
  const root=privateTemp('preview-diagnostic-'),mapping=observedMapping('http://fixture.invalid'),event=candidate({platformEventId:'private-native-id',
    actorId:'200',conversationId:'conv-a',text:'[图片或表情消息，需人工查看]',observationIssue:'DM_CONTENT_UNVERIFIED',contentType:'IMAGE'});
  const batch:ObservationBatch={events:[event],evidenceId:'synthetic',unsupported:1,loaded:1,
    bindings:[{targetKey:'dm:conv-a',uid:'200',secUid:'peer-sec',title:'private-title',conversationId:'conv-a'}]};
  const screenshot=vi.fn(async()=>{if(outcome==='CAPTURE_FAILURE')throw Error('private screenshot error https://secret.invalid/');return png;});
  const page={screenshot,evaluate:async(fn:unknown,input:{imageIndex?:number})=>{
    if(fn!==inspectMessageImage)return batch;
    if(outcome==='INSPECT_FAILURE')throw Error('page.evaluate: Error: MESSAGE_PREVIEW_INSPECT_CONVERSATION_FAILED private exception payload');
    return {count:1,label:'private-alt',reason:null,sourceFingerprint:'a'.repeat(64),clip:{x:0,y:0,width:1,height:1},imageIndex:input.imageIndex};
  }} as unknown as Page;
  await saveMessagePreviews(page,mapping,batch,root,new AbortController().signal);
  const file=join(root,'evidence','message-preview-latest.json'),raw=readFileSync(file,'utf8'),diagnostic=JSON.parse(raw);
  expect(diagnostic).toMatchObject({batchDMcount:1,eligibleCount:1,ready:outcome==='READY'?1:0,cancelled:false});
  expect(raw).not.toContain('private');expect(raw).not.toContain(event.platformEventId);expect(raw).not.toContain('https://');
  const attachments=new MessagePreviewStore(root).list(event,'100');expect(attachments).toHaveLength(1);
  if(outcome==='READY'){expect(attachments[0]).toMatchObject({state:'READY'});expect(diagnostic.caught).toEqual({});}
  else{
    expect(attachments[0]).toMatchObject({state:'UNAVAILABLE',reason:outcome==='INSPECT_FAILURE'?'MESSAGE_PREVIEW_INSPECT_CONVERSATION_FAILED':'MESSAGE_PREVIEW_CAPTURE_FAILED'});
    expect(diagnostic.caught).toEqual({[outcome==='INSPECT_FAILURE'?'INSPECT_BEFORE':'CAPTURE']:1});
    expect(Object.values(diagnostic.unavailable)).toEqual([1]);
  }
  await saveMessagePreviews(page,mapping,{...batch,events:[]},root,new AbortController().signal);
  expect(JSON.parse(readFileSync(file,'utf8'))).toMatchObject({batchDMcount:0,eligibleCount:0,inspected:0,ready:0,caught:{}});
  expect(JSON.parse(readFileSync(join(root,'evidence','message-preview-last-nonempty.json'),'utf8'))).toEqual(diagnostic);
  expect(readdirSync(join(root,'evidence')).filter(name=>name!=='message-previews').sort()).toEqual(['message-preview-last-nonempty.json','message-preview-latest.json']);
});

test('normal obstruction diagnostics bind each before image to its exact opaque event and retain the eight-sample cap',async()=>{
  const root=privateTemp('preview-bound-diagnostic-'),mapping=observedMapping('http://fixture.invalid');
  const events=Array.from({length:3},(_,index)=>candidate({platformEventId:'private-native-'+index,actorId:'200',conversationId:'conv-a',
    text:'private body '+index,observationIssue:'DM_CONTENT_UNVERIFIED',contentType:'IMAGE'}));
  const batch:ObservationBatch={events,evidenceId:'synthetic-private-evidence',unsupported:3,loaded:3,
    bindings:[{targetKey:'dm:conv-a',uid:'200',secUid:'private-peer',title:'private-title',conversationId:'conv-a'}]};
  const screenshot=vi.fn(),evaluate=vi.fn(async(fn:unknown)=>fn===inspectMessageImage?{
    count:4,label:'private-alt',reason:'MESSAGE_PREVIEW_OBSCURED',sourceFingerprint:'',clip:null,
    obstruction:{stage:'OVERLAP',imagePointerEvents:'auto',tag:'DIV',ancestor:false,pointerEvents:'none',position:'static',zIndex:'auto'},
  }:{detected:false});
  await saveMessagePreviews({screenshot,evaluate} as unknown as Page,mapping,batch,root,new AbortController().signal);
  const raw=readFileSync(join(root,'evidence','message-preview-latest.json'),'utf8'),report=JSON.parse(raw);
  expect(report.imageObstructions).toHaveLength(8);
  expect(report.imageObstructions.map((sample:{eventBinding:string;imageIndex:number;phase:string})=>[sample.eventBinding,sample.imageIndex,sample.phase]))
    .toEqual(events.slice(0,2).flatMap(event=>Array.from({length:4},(_,imageIndex)=>[eventBinding(event),imageIndex,'BEFORE'])));
  expect(report.imageObstructions.every((sample:{eventBinding:string})=>/^[a-f0-9]{64}$/u.test(sample.eventBinding))).toBe(true);
  expect(raw).not.toMatch(/private|conv-a|https?:\/\//u);expect(screenshot).not.toHaveBeenCalled();
  expect(evaluate).toHaveBeenCalledTimes(15);
  expect(report.unavailable).toEqual({MESSAGE_PREVIEW_OBSCURED:12});
});
