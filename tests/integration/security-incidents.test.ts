import {expect,test} from 'vitest';
import {readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {Page} from 'playwright';
import {EventStore} from '../../src/storage/store.js';
import {SecurityIncidents,type IncidentContext} from '../../src/app/security-incidents.js';
import {readSecurityHold} from '../../src/storage/security-holds.js';
import {digest} from '../../src/core/contracts.js';
import type {SecuritySignal} from '../../src/adapters/security-signal.js';
import {privateTemp} from '../helpers.js';

const channel='COMMENT_NOTIFICATION' as const;
const context:IncidentContext={mode:'headless',epoch:3,instanceId:'synthetic-backend',selectors:['#synthetic-candidate'],mappingDigest:digest('synthetic-mapping')};
const signal=(overrides:Partial<SecuritySignal>={}):SecuritySignal=>({version:1,state:'SUSPECT',kind:'COMPONENT',
  href:'https://www.douyin.com/video/10',origin:'https://www.douyin.com',title:'Synthetic page',documentStartedAt:100,observedAt:200,
  target:{workId:'10'},matches:[{selector:'#synthetic-candidate',tag:'DIV',id:'synthetic-candidate',visible:true,left:0,top:0,right:320,bottom:180}],
  frames:[{src:'https://rmc.bytedance.com/synthetic-frame',title:'Synthetic frame',left:0,top:0,right:320,bottom:180}],...overrides});
function fakePage(initial:SecuritySignal,options:{before?:SecuritySignal;afterScreenshot?:SecuritySignal;after?:{href:string;started:number};snapshotFails?:boolean;postSnapshotFails?:boolean;screenshotFails?:boolean}={}){
  let screenshots=0,evaluations=0;
  const main={url:()=>initial.href,parentFrame:()=>null};
  const child={url:()=>initial.frames[0]!.src,parentFrame:()=>main};
  const page={
    evaluate:async()=>{evaluations++;if(evaluations===1){if(options.snapshotFails)throw new Error('synthetic snapshot failure');return options.before??initial;}
      if(evaluations===2){if(options.postSnapshotFails)throw new Error('synthetic post screenshot snapshot failure');return options.afterScreenshot??options.before??initial;}
      return options.after??{href:initial.href,started:initial.documentStartedAt};},
    frames:()=>[main,child],
    screenshot:async()=>{screenshots++;if(options.screenshotFails)throw new Error('synthetic screenshot failure');return Buffer.from('synthetic-jpeg-bytes');},
  } as unknown as Page;
  return{page,screenshots:()=>screenshots};
}
async function fixture(){
  const root=privateTemp('security-incidents-'),store=new EventStore(join(root,'poc.sqlite'),true),recorder=new SecurityIncidents(root,store);
  return{root,store,recorder,close:async()=>{store.close();await rm(root,{recursive:true,force:true});}};
}

test('one incident binds the original document, child-frame relationship, screenshot and actual backend rule fingerprint',async()=>{
  const f=await fixture(),initial=signal(),fake=fakePage(initial);
  try{
    await f.recorder.record(channel,fake.page,initial,context);
    const hold=readSecurityHold(f.store,channel)!;expect(hold.documentDigest).toBe(digest([initial.href,initial.documentStartedAt]));
    expect(hold.source).toBe('UNKNOWN');
    const saved=await f.recorder.read(hold.incidentId);
    expect(saved).toMatchObject({initial,afterFailure:initial,afterScreenshot:initial,sameDocument:true,incomplete:[],context,frames:[{url:initial.href,parent:null},{url:initial.frames[0]!.src,parent:0}]});
    expect(saved!.screenshot).toEqual({file:hold.incidentId+'.jpg',digest:digest(Buffer.from('synthetic-jpeg-bytes').toString('base64'))});
    const file=JSON.parse(await readFile(join(f.root,'evidence/security-incidents',hold.incidentId+'.json'),'utf8')) as {runtime:{instanceId:string;fingerprint:string}};
    expect(file.runtime).toMatchObject({instanceId:context.instanceId,fingerprint:expect.stringMatching(/^[a-f0-9]{64}$/u)});
    expect(fake.screenshots()).toBe(1);
  }finally{await f.close();}
});

test.each(['before','during'] as const)('property insertion order alone does not mark the signal as changed %s screenshot',async stage=>{
  const f=await fixture(),initial=signal(),reordered=signal({
    matches:initial.matches.map(({selector,tag,id,visible,left,top,right,bottom})=>({bottom,right,top,left,id,tag,selector,visible})),
    frames:initial.frames.map(({src,title,left,top,right,bottom})=>({bottom,right,top,left,title,src})),observedAt:300});
  expect(digest([initial.state,initial.matches,initial.frames])).not.toBe(digest([reordered.state,reordered.matches,reordered.frames]));
  const fake=fakePage(initial,stage==='before'?{before:reordered}:{afterScreenshot:reordered});
  try{
    await f.recorder.record(channel,fake.page,initial,context);
    const held=readSecurityHold(f.store,channel)!,saved=(await f.recorder.read(held.incidentId))!;
    expect(saved).toMatchObject({initial,afterScreenshot:reordered,sameDocument:true,incomplete:[]});
    expect(saved.screenshot).not.toBeNull();expect(readSecurityHold(f.store,channel)?.revision).toBe(held.revision);
  }finally{await f.close();}
});

test.each((['before','during'] as const).flatMap(stage=>(['match-coordinate','frame-source','frame-coordinate','visible'] as const)
  .map(change=>({stage,change}))))('a real $change change $stage screenshot remains marked',async({stage,change})=>{
  const f=await fixture(),initial=signal(),changed=signal({observedAt:300,
    matches:initial.matches.map(match=>({...match,...(change==='match-coordinate'?{left:1}:change==='visible'?{visible:false}:{})})),
    frames:initial.frames.map(frame=>({...frame,...(change==='frame-source'?{src:'https://rmc.bytedance.com/changed-frame'}:change==='frame-coordinate'?{right:321}:{})}))});
  const fake=fakePage(initial,stage==='before'?{before:changed}:{afterScreenshot:changed});
  try{
    await f.recorder.record(channel,fake.page,initial,context);
    const held=readSecurityHold(f.store,channel)!,saved=(await f.recorder.read(held.incidentId))!;
    expect(saved.initial).toEqual(initial);expect(saved.afterScreenshot).toEqual(changed);expect(saved.sameDocument).toBe(true);
    expect(saved.incomplete).toEqual([stage==='before'?'SIGNAL_CHANGED_BEFORE_SCREENSHOT':'SIGNAL_CHANGED_DURING_SCREENSHOT']);
    expect(saved.screenshot).not.toBeNull();expect(readSecurityHold(f.store,channel)?.revision).toBe(held.revision);
  }finally{await f.close();}
});

test.each(['before','during'] as const)('a signal disappearing %s screenshot remains separate from the original signal and is marked as changed',async stage=>{
  const f=await fixture(),initial=signal(),clear=signal({state:'CLEAR',matches:[],frames:[],observedAt:300});
  const fake=fakePage(initial,stage==='before'?{before:clear}:{afterScreenshot:clear});
  try{
    await f.recorder.record(channel,fake.page,initial,context);
    const held=readSecurityHold(f.store,channel)!,saved=(await f.recorder.read(held.incidentId))!;
    expect(saved.initial).toEqual(initial);expect(saved.afterScreenshot).toEqual(clear);
    expect(saved.incomplete).toContain(stage==='before'?'SIGNAL_CHANGED_BEFORE_SCREENSHOT':'SIGNAL_CHANGED_DURING_SCREENSHOT');
    expect(saved.sameDocument).toBe(true);expect(saved.screenshot).not.toBeNull();
    expect(readSecurityHold(f.store,channel)?.revision).toBe(held.revision);
  }finally{await f.close();}
});

test('a failed post-screenshot observation cannot be reported as a stable signal',async()=>{
  const f=await fixture(),initial=signal(),fake=fakePage(initial,{postSnapshotFails:true});
  try{
    await f.recorder.record(channel,fake.page,initial,context);
    const held=readSecurityHold(f.store,channel)!,saved=(await f.recorder.read(held.incidentId))!;
    expect(saved.afterScreenshot).toBeNull();expect(saved.incomplete).toContain('POST_SCREENSHOT_SIGNAL_UNAVAILABLE');
    expect(saved.sameDocument).toBe(true);expect(saved.screenshot).not.toBeNull();
    expect(readSecurityHold(f.store,channel)?.revision).toBe(held.revision);
  }finally{await f.close();}
});

test.each(['before','during'] as const)('navigation %s screenshot invalidates visual evidence while retaining the exact original signal and hold',async stage=>{
  const f=await fixture(),initial=signal(),other=signal({href:'https://www.douyin.com/video/99',documentStartedAt:101});
  const fake=fakePage(initial,stage==='before'?{before:other}:{after:{href:other.href,started:other.documentStartedAt}});
  try{
    await f.recorder.record(channel,fake.page,initial,context);
    const hold=readSecurityHold(f.store,channel)!,saved=(await f.recorder.read(hold.incidentId))!;
    expect(saved.initial).toEqual(initial);expect(saved.sameDocument).toBe(false);expect(saved.screenshot).toBeNull();
    expect(saved.incomplete).toContain(stage==='before'?'DOCUMENT_CHANGED_OR_INITIAL_MISSING':'DOCUMENT_CHANGED_DURING_SCREENSHOT');
    expect(fake.screenshots()).toBe(stage==='before'?0:1);
    expect((await readdir(join(f.root,'evidence/security-incidents'))).filter(name=>name.endsWith('.jpg'))).toEqual([]);
    expect(readSecurityHold(f.store,channel)?.revision).toBe(hold.revision);
  }finally{await f.close();}
});

test.each(['href','document-start'] as const)('a changed post-screenshot %s cannot be healed by the final original-document reading',async change=>{
  const f=await fixture(),initial=signal(),other=signal(change==='href'?{href:'https://www.douyin.com/video/99'}:{documentStartedAt:101});
  const fake=fakePage(initial,{afterScreenshot:other});
  try{
    await f.recorder.record(channel,fake.page,initial,context);
    const hold=readSecurityHold(f.store,channel)!,saved=(await f.recorder.read(hold.incidentId))!;
    expect(saved.initial).toEqual(initial);expect(saved.afterFailure).toEqual(initial);expect(saved.afterScreenshot).toEqual(other);
    expect(saved.sameDocument).toBe(false);expect(saved.screenshot).toBeNull();
    expect(saved.incomplete).toContain('DOCUMENT_CHANGED_DURING_SCREENSHOT');
    expect((await readdir(join(f.root,'evidence/security-incidents'))).filter(name=>name.endsWith('.jpg'))).toEqual([]);
    expect(readSecurityHold(f.store,channel)?.revision).toBe(hold.revision);
  }finally{await f.close();}
});

test.each(['snapshot','screenshot','missing-initial'] as const)('%s failure is recorded as incomplete and cannot clear the hold',async failure=>{
  const f=await fixture(),initial=signal(),fake=fakePage(initial,{snapshotFails:failure==='snapshot',screenshotFails:failure==='screenshot'});
  try{
    await f.recorder.record(channel,fake.page,failure==='missing-initial'?null:initial,context);
    const hold=readSecurityHold(f.store,channel)!,saved=(await f.recorder.read(hold.incidentId))!;
    expect(saved.screenshot).toBeNull();
    expect(saved.incomplete).toContain(failure==='snapshot'?'AFTER_FAILURE_SNAPSHOT_UNAVAILABLE':failure==='screenshot'?'SCREENSHOT_UNAVAILABLE':'INITIAL_SIGNAL_UNAVAILABLE');
    expect(readSecurityHold(f.store,channel)?.revision).toBe(hold.revision);
  }finally{await f.close();}
});

test('a storage failure still persists the hold and records a fixed evidence-unavailable event',async()=>{
  const f=await fixture(),initial=signal(),fake=fakePage(initial);
  try{
    await new SecurityIncidents(join(f.root,'nonexistent'),f.store).record(channel,fake.page,initial,context);
    const hold=readSecurityHold(f.store,channel)!;expect(hold).not.toBeNull();
    expect(f.store.db.prepare("SELECT entity_id FROM audit_events WHERE event_type='SECURITY_INCIDENT_EVIDENCE_UNAVAILABLE'").get()).toEqual({entity_id:hold.incidentId});
    expect(fake.screenshots()).toBe(0);
  }finally{await f.close();}
});

test('an external top-level URL remains explicit evidence and a child-frame domain never becomes a Douyin-page or confirmed-challenge claim',async()=>{
  const f=await fixture(),initial=signal({href:'https://example.invalid/synthetic',origin:'https://example.invalid'}),fake=fakePage(initial);
  try{
    await f.recorder.record(channel,fake.page,initial,context);
    const saved=(await f.recorder.read(readSecurityHold(f.store,channel)!.incidentId))!;
    expect(saved.initial?.origin).toBe('https://example.invalid');expect(saved.initial?.state).toBe('SUSPECT');
    expect(saved.frames[0]!.url).toBe(initial.href);expect(saved.frames[1]!.url).toBe('https://rmc.bytedance.com/synthetic-frame');
    expect(readSecurityHold(f.store,channel)?.reason).toBe('OBSERVATION_SECURITY_SUSPECT');
  }finally{await f.close();}
});

test('repeated observations of an unresolved incident keep one hold and one evidence pair',async()=>{
  const f=await fixture(),initial=signal(),fake=fakePage(initial);
  try{
    await f.recorder.record(channel,fake.page,initial,context);const held=readSecurityHold(f.store,channel)!;
    await f.recorder.record(channel,fake.page,signal({documentStartedAt:500}),context);
    expect(readSecurityHold(f.store,channel)?.revision).toBe(held.revision);expect(fake.screenshots()).toBe(1);
    expect((await readdir(join(f.root,'evidence/security-incidents'))).sort()).toEqual([held.incidentId+'.jpg',held.incidentId+'.json'].sort());
    expect(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='SECURITY_CHANNEL_HELD'").get()).toEqual({n:1});
  }finally{await f.close();}
});
