import {lstat,mkdir,rename,unlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ShareInspection} from '../adapters/message-share.js';
import type {inspectMessageImage} from '../adapters/message-preview.js';

/** One overwritten, body-free operational snapshot; neither native IDs nor exception text belong here. */
export class MessagePreviewDiagnostics {
  readonly snapshot={at:new Date().toISOString(),batchDMcount:0,eligibleCount:0,inspected:0,ready:0,reusedReady:0,
    shareInspected:0,shareLinked:0,shareDetectedNoLink:0,shareSamples:[] as ShareInspection['diagnostic'][],
    imageObstructions:[] as NonNullable<Awaited<ReturnType<typeof inspectMessageImage>>['obstruction']>[],
    unavailable:{} as Record<string,number>,caught:{} as Record<string,number>,skipped:{} as Record<string,number>,cancelled:false};
  increment(group:'unavailable'|'caught'|'skipped',code:string):void {
    const safe=/^(?:MESSAGE_PREVIEW_[A-Z_]+|INSPECT_BEFORE|CAPTURE|INSPECT_AFTER|VERIFY_BINDING|CACHE_WRITE|SHARE_INSPECT|SHARE_WRITE|BINDING_MISSING|BINDING_CONFLICT)$/u.test(code)?code:'MESSAGE_PREVIEW_UNKNOWN_FAILURE';
    this.snapshot[group][safe]=(this.snapshot[group][safe]??0)+1;
  }
  async save(root:string):Promise<void> {
    const directory=join(resolve(root),'evidence'),temporary=join(directory,randomUUID()+'.preview-tmp');
    try{
      await mkdir(directory,{recursive:true});const dir=await lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())return;
      for(const name of ['message-preview-latest.json',...(this.snapshot.batchDMcount>0?['message-preview-last-nonempty.json']:[])]){
        const file=join(directory,name);
        try{const existing=await lstat(file);if(!existing.isFile()||existing.isSymbolicLink())return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return;}
        await writeFile(temporary,JSON.stringify(this.snapshot),{flag:'wx',mode:0o600});await rename(temporary,file);
      }
    }catch{/* Diagnostics must not lose the observed message or expose a raw filesystem error. */}
    finally{await unlink(temporary).catch(()=>{});}
  }
}
