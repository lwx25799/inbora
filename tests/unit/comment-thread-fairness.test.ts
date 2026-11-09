import {expect,test} from 'vitest';
import {collectCommentThread,commentThreadsSchema} from '../../src/app/comment-thread-collection.js';
import type {ObservedReader,ObservationBatch} from '../../src/adapters/observed-reader.js';
import {candidate} from '../helpers.js';
import {eventBinding} from '../../src/core/contracts.js';

test.each([false,true])('new roots join behind an existing pending root instead of continually taking its turn after restart (legacy %s)',async legacy=>{
  const root=(id:string)=>candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'10',commentId:id,platformEventId:id,conversationId:null});
  let states=commentThreadsSchema.parse([]);const roots=[root('11')],selected:string[]=[];
  if(legacy){states=commentThreadsSchema.parse([{workId:'10',id:'11',binding:eventBinding(roots[0]!),total:3,seen:[],offset:0,done:false}]);expect(states[0]!.turn).toBe(0);}
  const reader={async commentThread(event:ReturnType<typeof root>){
    selected.push(event.commentId!);
    return{events:[{...event,kind:'REPLY',platformEventId:event.commentId+'01',commentId:event.commentId+'01',rootCommentId:event.commentId!,replyToCommentId:event.commentId+'01'}],
      evidenceId:'synthetic',commentThread:{initialTotal:3,beforeTotal:3,total:3,mounted:1,offset:0,nextOffset:1,expandable:true,expanded:true}};
  }} as unknown as ObservedReader;
  for(let turn=0;turn<8;turn++){
    if(turn>0)roots.push(root(String(11+turn)));
    const batch:ObservationBatch={events:roots,evidenceId:'synthetic',loaded:roots.length,unsupported:0,
      commentThreads:roots.map(event=>({id:event.commentId!,total:3,mounted:0,expandable:true}))};
    await collectCommentThread(reader,'10',batch,states,turn*1000,async()=>{});
    states=commentThreadsSchema.parse(JSON.parse(JSON.stringify(states)));
  }
  expect(selected.filter(id=>id==='11').length).toBeGreaterThan(1);
  expect(selected.slice(0,4)).toEqual(['11','11','12','11']);
  expect(states.every(state=>!state.done)).toBe(true);
});
