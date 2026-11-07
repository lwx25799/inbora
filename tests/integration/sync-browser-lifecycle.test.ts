import {expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {AccountActor} from '../../src/browser/account-actor.js';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {DomAdapter} from '../../src/adapters/dom-adapter.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {database,privateTemp} from '../helpers.js';
import {mapping} from '../fixtures/site.js';

function gate(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return{promise,release};}
async function fixture(){
  const root=privateTemp('sync-lifecycle-'),store=database(),actor=new AccountActor(),context=new EventEmitter();
  const config=mapping('https://www.douyin.com');config.environment='douyin';
  await writeFile(join(root,'site-mapping.json'),JSON.stringify(config));await migrateClient(store,join(root,'backup.sqlite'));
  let closes=0;
  const owner={actor,context,notification:{},dm:{},version:()=> 'synthetic',open:async()=>{},close:async()=>{closes++;}} as unknown as BrowserProfileOwner;
  return{root,store,owner,context,get closes(){return closes;},close:()=>store.close()};
}

test('an in-flight actual BrowserService observation cannot replace CLOSED after explicit close',async()=>{
  const f=await fixture(),read=gate(),entered=gate();
  const observe=vi.spyOn(DomAdapter.prototype,'observeNotifications').mockImplementation(async()=>{entered.release();await read.promise;return{events:[],evidenceId:'synthetic-only',loaded:0};});
  const browser=BrowserService.adopt(f.root,f.owner,'headed');
  let work:Promise<void>|undefined;
  try{
    work=browser.observe(f.store,'notifications');const outcome=work.catch(error=>error);await entered.promise;
    const closing=browser.close();read.release();await outcome;await closing;
    expect(browser.status()).toMatchObject({state:'CLOSED',version:null});expect(f.closes).toBe(1);
    expect(await browser.refreshIdentity('DIRECT_MESSAGE')).toBeNull();
  }finally{read.release();await work?.catch(()=>{});observe.mockRestore();await browser.close();f.close();}
});

test('natural context close during a real observation stops inbox sync without launching a second browser',async()=>{
  const f=await fixture(),read=gate(),entered=gate();let launches=0;
  const observe=vi.spyOn(DomAdapter.prototype,'observeNotifications').mockImplementation(async()=>{entered.release();await read.promise;throw Error('synthetic page closed');});
  const browser=new BrowserService(f.root,async()=>{launches++;return f.owner;});
  let service:ClientService|undefined;
  try{
    // Use the real observation path under a synthetic owner; no browser process is launched.
    const normalObserve=browser.observe.bind(browser);
    vi.spyOn(browser,'observe').mockImplementation((store)=>normalObserve(store,'notifications'));
    service=new ClientService(f.store,browser);const token=service.authority.issueSession();
    await service.dispatch(token,{command:'syncInbox'});await entered.promise;
    for(const channel of ['COMMENT_NOTIFICATION','DIRECT_MESSAGE'] as const)
      service.authority.attest(channel,'SEND_AVAILABLE',browser.identity(channel)!,'synthetic-existing-capability');
    f.context.emit('close');read.release();await service.drain();
    expect(launches).toBe(1);expect(browser.status()).toMatchObject({state:'CLOSED',version:null});
    expect(f.store.db.prepare("SELECT count(*) AS n FROM channel_capabilities WHERE state='SEND_AVAILABLE'").get()).toEqual({n:2});
    expect(await service.dispatch(token,{command:'getStatus'})).toMatchObject({sync:{running:false,results:[{state:'FAILED',error:'BROWSER_CLOSED'},{state:'SKIPPED'}]}});
  }finally{read.release();await service?.close();observe.mockRestore();f.close();}
});
