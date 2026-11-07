import { expect, test } from "vitest";
import { join } from "node:path";
import { ClientService } from "../../src/app/service.js";
import { BrowserService } from "../../src/app/browser-service.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { database, privateTemp, pending } from "../helpers.js";
import { DeepSeekProvider } from "../../src/ai/deepseek.js";
import { defaultSettings } from "../../src/app/contracts.js";

test("scope consent survives service restart and ordinary settings saves preserve Key and grant usage",async()=>{
  const root=privateTemp('automation-service-'),store=database();
  await migrateClient(store,join(root,'backup.sqlite'));
  let calls=0;
  const provider=new DeepSeekProvider(async()=>{calls++;return new Response(JSON.stringify({model:'deepseek-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Fixture suggestion'}}],
    usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}));});
  let service=new ClientService(store,new BrowserService(root),provider);
  try {
    const eventId=pending(store);await service.loadSettings();let token=service.authority.issueSession();
    await service.dispatch(token,{command:'configureAi',settings:defaultSettings,key:'synthetic-contract-key'});
    await service.dispatch(token,{command:'setModelGrant',scope:{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:1,expiresAt:null},confirmed:true});
    await service.dispatch(token,{command:'configureAi',settings:{...defaultSettings,business:'Ordinary business update'},key:''});
    expect(await service.dispatch(token,{command:'getStatus'})).toMatchObject({keyPresent:true,modelAuthorized:true});
    await service.dispatch(token,{command:'generateSuggestion',eventId,draftVersion:0});expect(calls).toBe(1);
    await expect(service.dispatch(token,{command:'generateSuggestion',eventId,draftVersion:0})).rejects.toThrow('MODEL_GRANT_EXHAUSTED');
    expect(calls).toBe(1);
    await service.close();
    service=new ClientService(store,new BrowserService(root),provider);await service.loadSettings();token=service.authority.issueSession();
    expect(await service.dispatch(token,{command:'getStatus'})).toMatchObject({keyPresent:false,modelAuthorized:true,paused:false,automation:{modelGrant:{version:1}}});
    await service.dispatch(token,{command:'setModelGrant',scope:null,confirmed:true});
    expect(await service.dispatch(token,{command:'getStatus'})).toMatchObject({modelAuthorized:false});
    await expect(service.dispatch(token,{command:'authorizeAi',authorized:true})).rejects.toThrow('USE_PERSISTENT_MODEL_GRANT');
    expect(store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get()).toEqual({used:1});
  }finally{await service.close();store.close();}
});

test.each(['setKeyStorage','clearModelKey'] as const)('later %s cannot be undone by an earlier asynchronous configuration save',async command=>{
  const root=privateTemp('credential-config-race-'),store=database();await migrateClient(store,join(root,'client.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  try{
    const saving=service.dispatch(token,{command:'configureAi',settings:defaultSettings,key:'synthetic-late-config-key'});
    const clearing=service.dispatch(token,command==='setKeyStorage'?{command,storage:'DELETE'}:{command});
    await Promise.all([saving,clearing]);
    expect(await service.dispatch(token,{command:'getStatus'})).toMatchObject({keyPresent:false,keyStored:false});
  }finally{await service.close();store.close();}
});
