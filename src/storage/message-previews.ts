import { existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,unlinkSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest,eventBinding,requireSafe,type InboundEvent } from '../core/contracts.js';
import { runtimeSchema } from '../config/runtime.js';

export interface MessagePreviewAttachment {
  previewId:string|null;kind:'IMAGE';label:string|null;state:'READY'|'UNAVAILABLE';reason?:string|undefined;width?:number|undefined;height?:number|undefined;
}
export interface MessagePreviewData {previewId:string;mime:'image/png';dataUrl:string;width:number;height:number}
export interface CapturedMessageImage {label:string|null;reason?:string;png?:Buffer;width?:number;height?:number}
export const maximumPreviewBytes=160*1024;
const maximumMessages=500,maximumCacheBytes=80*1024*1024;
const idSchema=z.string().regex(/^[a-f0-9]{64}$/u);
const attachmentSchema=z.object({previewId:idSchema.nullable(),kind:z.literal('IMAGE'),label:z.string().max(120).nullable(),
  state:z.enum(['READY','UNAVAILABLE']),reason:z.string().regex(/^MESSAGE_PREVIEW_[A-Z_]+$/u).optional(),
  width:z.number().int().min(1).max(512).optional(),height:z.number().int().min(1).max(512).optional()}).strict();
const displayTextSchema=z.string().min(1).max(10_000).refine(text=>text.trim().length>0&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text));
const manifestSchema=z.object({version:z.literal(1),key:idSchema,attachments:z.array(attachmentSchema).max(4),displayText:displayTextSchema.optional()}).strict();

function pngSize(bytes:Buffer):{width:number;height:number}|null {
  if(bytes.length<33||bytes.length>maximumPreviewBytes||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||
    bytes.toString('ascii',12,16)!=='IHDR')return null;
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  return width>0&&width<=512&&height>0&&height<=512?{width,height}:null;
}

/** Local thumbnails are evidence of one exact native message, never trusted message text or provider context. */
export class MessagePreviewStore {
  constructor(readonly root:string){}
  private retentionMs():number {
    const file=join(this.root,'runtime.json');
    return (existsSync(file)?runtimeSchema.parse(JSON.parse(readFileSync(file,'utf8'))).evidenceRetentionDays:14)*86_400_000;
  }
  private key(event:InboundEvent,ownId:string):string {
    requireSafe(!!ownId&&event.channel==='DIRECT_MESSAGE'&&!!event.platformEventId&&!!event.conversationId&&!!event.actorId&&
      event.observationIssue==='DM_CONTENT_UNVERIFIED','MESSAGE_PREVIEW_UNAVAILABLE');
    return digest([ownId,event.channel,event.platformEventId,event.conversationId,event.actorId,event.direction,eventBinding(event)]);
  }
  private directory(create=false):string {
    let directory=resolve(this.root);
    requireSafe(existsSync(directory)&&lstatSync(directory).isDirectory(),'MESSAGE_PREVIEW_UNAVAILABLE');
    for(const name of ['evidence','message-previews']){
      directory=join(directory,name);
      if(create&&!existsSync(directory))mkdirSync(directory,{mode:0o700});
      const stat=lstatSync(directory);
      requireSafe(stat.isDirectory()&&!stat.isSymbolicLink(),'MESSAGE_PREVIEW_UNAVAILABLE');
    }
    return directory;
  }
  private manifest(event:InboundEvent,ownId:string){
    const key=this.key(event,ownId),directory=this.directory(),file=join(directory,key+'.json'),stat=lstatSync(file);
    requireSafe(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=65_536&&Date.now()-stat.mtimeMs<=this.retentionMs(),'MESSAGE_PREVIEW_UNAVAILABLE');
    const manifest=manifestSchema.parse(JSON.parse(readFileSync(file,'utf8')));
    requireSafe(manifest.key===key,'MESSAGE_PREVIEW_UNAVAILABLE');return {manifest,directory};
  }
  list(event:InboundEvent,ownId:string):MessagePreviewAttachment[] {
    try{return this.manifest(event,ownId).manifest.attachments;}catch{return [];}
  }
  /** Exact native text for human display only; callers never promote the original event's quality. */
  displayText(event:InboundEvent,ownId:string):string|null {
    try{return this.manifest(event,ownId).manifest.displayText??null;}catch{return null;}
  }
  /** A null witness revokes only display text; the original event and existing images are untouched. */
  saveDisplayText(event:InboundEvent,ownId:string,text:string|null):void {
    const parsed=displayTextSchema.nullable().safeParse(text);requireSafe(parsed.success,'MESSAGE_PREVIEW_UNAVAILABLE');
    const key=this.key(event,ownId),directory=this.directory(true),attachments=this.list(event,ownId);
    this.writeManifest(directory,manifestSchema.parse({version:1,key,attachments,...(text===null?{}:{displayText:text})}));this.prune(directory);
  }
  private writeManifest(directory:string,manifest:z.infer<typeof manifestSchema>):void {
    const temporary=join(directory,randomUUID()+'.tmp');
    try{writeFileSync(temporary,JSON.stringify(manifest),{flag:'wx',mode:0o600});renameSync(temporary,join(directory,manifest.key+'.json'));}
    finally{if(existsSync(temporary))unlinkSync(temporary);}
  }
  read(event:InboundEvent,ownId:string,previewId:string):MessagePreviewData {
    try{
      idSchema.parse(previewId);const {manifest,directory}=this.manifest(event,ownId);
      const attachment=manifest.attachments.find(item=>item.previewId===previewId&&item.state==='READY');
      requireSafe(attachment,'MESSAGE_PREVIEW_UNAVAILABLE');const file=join(directory,previewId+'.png'),stat=lstatSync(file);
      requireSafe(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=maximumPreviewBytes,'MESSAGE_PREVIEW_UNAVAILABLE');
      const bytes=readFileSync(file),size=pngSize(bytes);
      requireSafe(size&&size.width===attachment.width&&size.height===attachment.height,'MESSAGE_PREVIEW_UNAVAILABLE');
      requireSafe(manifest.attachments.some((item,index)=>item===attachment&&digest([manifest.key,index,digest(bytes)])===previewId),'MESSAGE_PREVIEW_UNAVAILABLE');
      return {previewId,mime:'image/png',dataUrl:'data:image/png;base64,'+bytes.toString('base64'),width:size.width,height:size.height};
    }catch{requireSafe(false,'MESSAGE_PREVIEW_UNAVAILABLE');}
  }
  save(event:InboundEvent,ownId:string,images:CapturedMessageImage[]):void {
    const key=this.key(event,ownId),directory=this.directory(true);this.prune(directory);
    const previous=this.list(event,ownId),displayText=this.displayText(event,ownId);
    let bytesOnDisk=readdirSync(directory).filter(name=>/^[a-f0-9]{64}\.png$/u.test(name)).reduce((total,name)=>{
      const stat=lstatSync(join(directory,name));return total+(stat.isFile()&&!stat.isSymbolicLink()?stat.size:0);
    },0);
    const attachments:MessagePreviewAttachment[]=images.slice(0,4).map((image,index)=>{
      const label=image.label?.replace(/[\u0000-\u001f\u007f]/gu,'').slice(0,120)||null;
      const size=image.png?pngSize(image.png):null;
      if(!image.png||!size){
        const existing=previous[index];if(existing?.state==='READY'&&existing.label===label)return existing;
        return {previewId:null,kind:'IMAGE',label,state:'UNAVAILABLE',reason:image.reason??'MESSAGE_PREVIEW_CAPTURE_FAILED'};
      }
      const previewId=digest([key,index,digest(image.png)]),file=join(directory,previewId+'.png');
      if(!existsSync(file)){
        if(bytesOnDisk+image.png.length>maximumCacheBytes)return {previewId:null,kind:'IMAGE',label,state:'UNAVAILABLE',reason:'MESSAGE_PREVIEW_CACHE_FULL'};
        writeFileSync(file,image.png,{flag:'wx',mode:0o600});bytesOnDisk+=image.png.length;
      }
      return {previewId,kind:'IMAGE',label,state:'READY',width:size.width,height:size.height};
    });
    this.writeManifest(directory,manifestSchema.parse({version:1,key,attachments,...(displayText===null?{}:{displayText})}));
    for(const old of previous)if(old.previewId&&!attachments.some(item=>item.previewId===old.previewId))this.removeImage(directory,old.previewId);
    this.prune(directory);
  }
  private removeImage(directory:string,id:string):void {
    if(!idSchema.safeParse(id).success)return;const file=join(directory,id+'.png');
    try{const stat=lstatSync(file);if(stat.isFile()&&!stat.isSymbolicLink())unlinkSync(file);}catch{/* A rebuildable thumbnail may already be absent. */}
  }
  private prune(directory:string):void {
    const records:{file:string;modified:number;bytes:number;manifest:z.infer<typeof manifestSchema>}[]=[];
    for(const name of readdirSync(directory)){
      if(!/^[a-f0-9]{64}\.json$/u.test(name))continue;
      try{
        const file=join(directory,name),stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65_536)continue;
        const manifest=manifestSchema.parse(JSON.parse(readFileSync(file,'utf8')));if(name!==manifest.key+'.json')continue;
        const bytes=manifest.attachments.reduce((total,item)=>{
          if(!item.previewId)return total;try{const image=lstatSync(join(directory,item.previewId+'.png'));return total+(image.isFile()&&!image.isSymbolicLink()?image.size:0);}catch{return total;}
        },stat.size);
        records.push({file,modified:stat.mtimeMs,bytes,manifest});
      }catch{/* Unknown or invalid files are outside cache retention ownership. */}
    }
    records.sort((a,b)=>a.modified-b.modified);let count=records.length,total=records.reduce((bytes,item)=>bytes+item.bytes,0);
    const retentionMs=this.retentionMs();
    for(const record of records){
      if(Date.now()-record.modified<=retentionMs&&count<=maximumMessages&&total<=maximumCacheBytes)break;
      for(const image of record.manifest.attachments)if(image.previewId)this.removeImage(directory,image.previewId);
      unlinkSync(record.file);count--;total-=record.bytes;
    }
  }
}
