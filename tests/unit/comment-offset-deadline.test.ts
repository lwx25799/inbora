import {expect,test,vi} from 'vitest';
import type {Page} from 'playwright';
import {recoverCommentOffset} from '../../src/adapters/comment-offset-recovery.js';
import {waitForCommentRender} from '../../src/adapters/comment-render.js';
import type {ObservationBatch} from '../../src/adapters/observed-reader.js';

test('the restoration deadline preserves the last persisted window without another native move',async()=>{
  const now=vi.spyOn(Date,'now').mockReturnValue(1000),writes:number[]=[],persisted:ObservationBatch[]=[];
  const batch:ObservationBatch={events:[],evidenceId:'fixture',loaded:0,unsupported:0,scroll:{top:0,height:1200,viewport:400,atEnd:false}};
  try{
    const result=await recoverCommentOffset({} as Page,20_000,async top=>{if(top!==undefined)writes.push(top);return batch;},async()=>batch,
      async value=>{persisted.push(value);now.mockReturnValue(31_001);});
    expect(persisted).toEqual([batch]);expect(writes).toEqual([]);expect(result.commentRestoreIncomplete).toBe(true);expect(result.scroll?.top).toBe(0);
  }finally{now.mockRestore();}
});

test('rendering timeout and cancellation cannot masquerade as completed browser frames',async()=>{
  const evaluate=vi.fn(async()=>false),page={evaluate} as unknown as Page;
  await expect(waitForCommentRender(page)).rejects.toThrow('OBSERVATION_COMMENT_RENDER_NOT_READY');
  const abort=new AbortController();abort.abort();
  await expect(waitForCommentRender(page,abort.signal)).rejects.toThrow('OBSERVATION_CANCELLED');expect(evaluate).toHaveBeenCalledTimes(1);
  await expect(waitForCommentRender(page,undefined,Date.now()-1)).rejects.toThrow('OBSERVATION_COMMENT_RENDER_NOT_READY');expect(evaluate).toHaveBeenCalledTimes(1);
});

test('a final read that completes after the restoration deadline remains incomplete and is still persisted',async()=>{
  const now=vi.spyOn(Date,'now').mockReturnValue(1000),persisted:ObservationBatch[]=[],page={evaluate:async()=>true} as unknown as Page;
  let top=0,reads=0;const batch=():ObservationBatch=>({events:[],evidenceId:'fixture',loaded:0,unsupported:0,scroll:{top,height:1200,viewport:400,atEnd:false}});
  try{
    const result=await recoverCommentOffset(page,320,async value=>{if(value!==undefined)top=value;return batch();},async()=>{
      if(++reads===2)now.mockReturnValue(31_001);return batch();
    },async value=>{persisted.push(value);});
    expect(result.commentRestoreIncomplete).toBe(true);expect(result.scroll?.top).toBe(320);expect(persisted).toHaveLength(2);
  }finally{now.mockRestore();}
});
