import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {ObservedDmReply,captureDmReply,type DmContextChange} from '../../src/adapters/observed-dm-reply.js';
import {SendCoordinator} from '../../src/core/send-coordinator.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountDmReply,dmReplyMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

test.each(['ORDER','REMOVE','ADD','CONTENT','TIME','STATE','CALLBACK_THROW'] as const)('post-fill %s changes produce only bounded context counts and still block before intent',async change=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('dm-context-diag-'),'profile'),true),store=database();
  let adapter:ObservedDmReply|undefined;
  const reports:DmContextChange[]=[];
  try{
    await mountDmReply(owner,server.origin);const mapping=dmReplyMapping(server.origin);
    const batch=await new ObservedReader(owner.dm,mapping.observation).dm(0);
    store.observe('DIRECT_MESSAGE','conv-a',[],'100','synthetic');store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','synthetic');
    const event=store.events()[0]!,draft=store.saveDraft(event.id,'private diagnostic outgoing text','mock');
    const options={onContextChanged:(report:DmContextChange)=>{reports.push(report);if(change==='CALLBACK_THROW')throw Error('PRIVATE_CALLBACK_ERROR');}};
    adapter=new ObservedDmReply(owner.dm,mapping,250,options);
    store.approve(draft.id,await adapter.inspect(event.payload),draft.version,draft.text);
    const evaluate=owner.dm.evaluate.bind(owner.dm);
    vi.spyOn(owner.dm,'evaluate').mockImplementation(async(fn,arg)=>{
      const result=await evaluate(fn,arg);
      if((fn as unknown)===captureDmReply&&(arg as {action?:string})?.action==='fill')await evaluate(change=>{
        const row=document.querySelectorAll('.message')[1]!,box=row.closest('.box')!,native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
        if(change==='ORDER'||change==='CALLBACK_THROW')box.parentElement!.append(box);
        if(change==='REMOVE')box.remove();
        if(change==='ADD'){
          const clone=box.cloneNode(true) as Element;Object.defineProperty(clone.querySelector('.message')!,'__reactProps$fixture',
            {value:{children:{props:{message:{...native,serverId:'99123'}}}}});box.parentElement!.append(clone);
        }
        if(change==='CONTENT'){native._parsedContent.text='PRIVATE_CHANGED_CONTENT';row.querySelector('.text')!.textContent=native._parsedContent.text;}
        if(change==='TIME')native.createdAt=new Date('2020-01-01T00:00:00Z');
        if(change==='STATE')native.serverStatus=1;
      },change);
      return result;
    });
    await expect(new SendCoordinator(store,owner.actor).send(draft.id,adapter,false)).rejects.toThrow('TARGET_CHANGED_REAPPROVE');
    expect(reports).toHaveLength(1);expect(reports[0]).toMatchObject({stage:'PREPARED',beforeRows:5,afterRows:change==='REMOVE'?4:change==='ADD'?6:5,
      added:change==='ADD'?1:0,removed:change==='REMOVE'?1:0,reordered:change==='ORDER'||change==='CALLBACK_THROW',
      changedRows:['CONTENT','TIME','STATE'].includes(change)?1:0});
    expect(reports[0]).toMatchObject({contentChanged:change==='CONTENT'?1:0,timeChanged:change==='TIME'?1:0,statusChanged:change==='STATE'?1:0});
    for(const forbidden of ['PRIVATE','private diagnostic','99123','conv-a','controlled-','Fixture'])expect(JSON.stringify(reports)).not.toContain(forbidden);
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(await evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{vi.restoreAllMocks();adapter?.dispose();store.close();await owner.close();await server.close();}
});
