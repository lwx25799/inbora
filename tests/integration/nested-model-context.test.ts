import {expect,test} from 'vitest';
import {DeepSeekProvider} from '../../src/ai/deepseek.js';
import {prompt} from '../../src/ai/draft-service.js';
import {candidate,database,snapshot} from '../helpers.js';

const settings={model:'deepseek-flash',persona:'简短',business:'准确',rules:'根据原文回答'};
const event=(id:string,text:string)=>candidate({channel:'COMMENT_NOTIFICATION',kind:id==='11'?'COMMENT':'REPLY',
  videoId:'10',commentId:id,platformEventId:id,conversationId:null,text,occurredAt:'2026-11-04T01:00:00.000Z',
  ...(id==='11'?{}:{rootCommentId:'11',replyToCommentId:id})});

test('the actual model prompt retains the first root through a long child thread and excludes foreign roots',()=>{
  const current=event('99','current question'),root=event('11','first original root');
  const children=Array.from({length:10},(_,i)=>event(String(20+i),'thread '+i));
  const foreign={...event('88','foreign private root'),rootCommentId:'12'};
  const business=prompt(current,[root,...children,foreign]).businessData as {history:{text:string;relation:string}[]};
  expect(business.history).toHaveLength(7);expect(business.history[0]).toEqual({text:root.text,direction:'INCOMING',relation:'ROOT_COMMENT'});
  expect(business.history.slice(1).map(item=>item.text)).toEqual(children.slice(-6).map(item=>item.text));
  expect(JSON.stringify(business)).not.toContain(foreign.text);
});

test('a missing root is rejected before model reservation, budget and transport',async()=>{
  const store=database();let calls=0,reservations=0;
  try{
    const current=event('99','current question');
    const provider=new DeepSeekProvider(async()=>{calls++;throw Error('must not call');});
    await expect(provider.generate(store,current,[],settings,'synthetic-key',true,undefined,()=>{reservations++;}))
      .rejects.toThrow('COMMENT_ROOT_CONTEXT_REQUIRED');
    expect(calls).toBe(0);expect(reservations).toBe(0);expect(store.budget('MODEL').used).toBe(0);
    expect(store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
  }finally{store.close();}
});

test('a root with an already confirmed answer remains one root and generates a child reply with one reservation',async()=>{
  const store=database();let calls=0,reservations=0;
  try{
    const root=event('11','first root question'),current=event('99','followup question');
    store.observe(root.channel,'notifications',[],'own-1','fixture','2026-11-04T00:59:59.000Z');
    store.observe(root.channel,'notifications',[root,current],'own-1','fixture','2026-11-04T01:00:01.000Z');
    const rootId=store.events().find(e=>e.payload.commentId==='11')!.id,draft=store.saveDraft(rootId,'our earlier root answer','mock');
    store.approve(draft.id,snapshot(root),draft.version,draft.text);
    const intent=store.recordIntent(draft.id,snapshot(root),false);store.receipt(intent,'CONFIRMED','synthetic-proof');
    const provider=new DeepSeekProvider(async(_url,options)=>{
      calls++;const body=JSON.parse(options!.body as string),data=JSON.parse(body.messages[1].content);
      expect(data.history[0].text).toBe(root.text);expect(data.history.filter((h:{relation:string})=>h.relation==='ROOT_COMMENT')).toHaveLength(1);
      expect(data.history.some((h:{text:string})=>h.text==='our earlier root answer')).toBe(true);
      return new Response(JSON.stringify({model:settings.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'A specific followup answer'}}],
        usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}));
    });
    await provider.generate(store,current,[],settings,'synthetic-key',true,undefined,()=>{reservations++;});
    expect(calls).toBe(1);expect(reservations).toBe(1);expect(store.budget('MODEL').used).toBe(1);
  }finally{store.close();}
});
