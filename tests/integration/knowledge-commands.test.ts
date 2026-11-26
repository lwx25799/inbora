import {afterEach,expect,test} from 'vitest';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {commandSchema} from '../../src/app/contracts.js';
import {EventStore} from '../../src/storage/store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,pending,privateTemp} from '../helpers.js';

const fixtures:{root:string;store:EventStore;service:ClientService}[]=[];
afterEach(async()=>{for(const f of fixtures.splice(0)){await f.service.close();f.store.close();rmSync(f.root,{recursive:true,force:true});}});
async function fixture(){
  const root=privateTemp('knowledge-commands-'),store=new EventStore(join(root,'test.sqlite'),true);
  await migrateClient(store,join(root,'schema3.sqlite'));pending(store,candidate());
  const service=new ClientService(store,new BrowserService(root));fixtures.push({root,store,service});await service.loadSettings();
  return{root,store,service,token:service.authority.issueSession()};
}
test('knowledge commands require control, validate consent and cannot spend without model authorization',async()=>{
  const f=await fixture(),read=f.service.authority.issueSession(['READ']);
  await expect(f.service.dispatch(read,{command:'replyKnowledge',action:'overview'})).rejects.toThrow();
  expect(commandSchema.safeParse({command:'replyKnowledge',action:'analyze',sampleIds:[],confirmed:false}).success).toBe(false);
  expect(commandSchema.safeParse({command:'replyKnowledge',action:'overview',unexpected:true}).success).toBe(false);
  await expect(f.service.dispatch(f.token,{command:'replyKnowledge',action:'tryReply',channel:'DIRECT_MESSAGE',message:'你好',
    personaVersionId:null,sourceIds:[],confirmed:true})).rejects.toThrow('REAL_MODEL_AUTHORIZATION_REQUIRED');
  expect(f.store.budget('MODEL').used).toBe(0);expect(f.store.budget('SEND').used).toBe(0);
});
test('chat import requires the exact reviewed mapping and repeats do not duplicate accepted source data',async()=>{
  const f=await fixture(),bytes=Buffer.from('客户:你好\n我:你好呀');
  const upload=async()=>{
    const {id}=await f.service.dispatch(f.token,{command:'replyKnowledge',action:'importStart',name:'chat.txt',bytes:bytes.length,kind:'CHAT'}) as {id:string};
    await f.service.dispatch(f.token,{command:'replyKnowledge',action:'importChunk',id,index:0,data:bytes.toString('base64')});
    await f.service.dispatch(f.token,{command:'replyKnowledge',action:'importFinish',id});return id;
  };
  const mapping={speakerColumn:'speaker',textColumn:'text',selfName:'我',channel:'DIRECT_MESSAGE' as const};
  const id=await upload();
  await expect(f.service.dispatch(f.token,{command:'replyKnowledge',action:'importCommit',id,mapping})).rejects.toThrow('KNOWLEDGE_MAPPING_PREVIEW_REQUIRED');
  expect(f.store.db.prepare('SELECT count(*) n FROM k_sources').get()).toEqual({n:0});
  await f.service.dispatch(f.token,{command:'replyKnowledge',action:'importPreviewMapping',id,mapping});
  await expect(f.service.dispatch(f.token,{command:'replyKnowledge',action:'importCommit',id,mapping:{...mapping,channel:'COMMENT_NOTIFICATION'}}))
    .rejects.toThrow('KNOWLEDGE_MAPPING_PREVIEW_REQUIRED');
  await f.service.dispatch(f.token,{command:'replyKnowledge',action:'importCommit',id,mapping});
  const repeat=await upload();await f.service.dispatch(f.token,{command:'replyKnowledge',action:'importPreviewMapping',id:repeat,mapping});
  await f.service.dispatch(f.token,{command:'replyKnowledge',action:'importCommit',id:repeat,mapping});
  expect(f.store.db.prepare('SELECT count(*) n FROM k_sources').get()).toEqual({n:1});
  expect(f.store.db.prepare('SELECT count(*) n,sum(accepted) accepted FROM k_samples').get()).toEqual({n:1,accepted:0});
  expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
});
