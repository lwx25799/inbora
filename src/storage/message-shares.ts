import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {digest,requireSafe,type InboundEvent} from '../core/contracts.js';
import {runtimeSchema} from '../config/runtime.js';

export interface MessageShare {kind:'DOUYIN_WORK';url:string;workId:string}
const shareSchema=z.object({kind:z.literal('DOUYIN_WORK'),url:z.string().regex(/^https:\/\/www\.douyin\.com\/(?:video|note)\/[0-9]{1,64}$/u),
  workId:z.string().regex(/^[0-9]{1,64}$/u)}).strict().refine(value=>value.url.endsWith('/'+value.workId));
const manifestSchema=z.object({version:z.literal(1),key:z.string().regex(/^[a-f0-9]{64}$/u),share:shareSchema}).strict();

/** A canonical public work link is display data; the original message, binding and quality remain unchanged. */
export class MessageShareStore {
  constructor(readonly root:string){}
  private key(event:InboundEvent,ownId:string):string {
    requireSafe(ownId&&event.channel==='DIRECT_MESSAGE'&&event.platformEventId&&event.conversationId&&event.actorId&&
      event.occurredAt&&Number.isFinite(Date.parse(event.occurredAt))&&event.observationIssue==='DM_CONTENT_UNVERIFIED',
      'MESSAGE_SHARE_UNAVAILABLE');
    return digest([ownId,event.accountId,event.channel,event.platformEventId,event.conversationId,event.actorId,event.direction,event.occurredAt]);
  }
  private directory(create=false):string {
    let path=resolve(this.root);requireSafe(lstatSync(path).isDirectory(),'MESSAGE_SHARE_UNAVAILABLE');
    for(const name of ['evidence','message-shares']){
      path=join(path,name);if(create&&!existsSync(path))mkdirSync(path,{mode:0o700});
      const stat=lstatSync(path);requireSafe(stat.isDirectory()&&!stat.isSymbolicLink(),'MESSAGE_SHARE_UNAVAILABLE');
    }
    return path;
  }
  private retentionMs():number {
    const file=join(this.root,'runtime.json');
    return (existsSync(file)?runtimeSchema.parse(JSON.parse(readFileSync(file,'utf8'))).evidenceRetentionDays:14)*86_400_000;
  }
  read(event:InboundEvent,ownId:string):MessageShare|null {
    try{
      const key=this.key(event,ownId),file=join(this.directory(),key+'.json'),stat=lstatSync(file);
      requireSafe(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=2048&&Date.now()-stat.mtimeMs<=this.retentionMs(),'MESSAGE_SHARE_UNAVAILABLE');
      const manifest=manifestSchema.parse(JSON.parse(readFileSync(file,'utf8')));
      requireSafe(manifest.key===key,'MESSAGE_SHARE_UNAVAILABLE');return manifest.share;
    }catch{return null;}
  }
  save(event:InboundEvent,ownId:string,share:MessageShare):void {
    try{
      const key=this.key(event,ownId),manifest=manifestSchema.parse({version:1,key,share}),directory=this.directory(true);
      const temporary=join(directory,randomUUID()+'.tmp');
      try{writeFileSync(temporary,JSON.stringify(manifest),{flag:'wx',mode:0o600});renameSync(temporary,join(directory,key+'.json'));}
      finally{if(existsSync(temporary))unlinkSync(temporary);}
      const entries=readdirSync(directory).filter(name=>/^[a-f0-9]{64}\.json$/u.test(name)).flatMap(name=>{
        const file=join(directory,name),stat=lstatSync(file);return stat.isFile()&&!stat.isSymbolicLink()?[{file,at:stat.mtimeMs}]:[];
      }).sort((a,b)=>b.at-a.at),retention=this.retentionMs();
      for(const [index,item] of entries.entries())if(index>=500||Date.now()-item.at>retention)unlinkSync(item.file);
    }catch{requireSafe(false,'MESSAGE_SHARE_UNAVAILABLE');}
  }
}
