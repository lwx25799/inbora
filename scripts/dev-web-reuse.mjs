import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';

/** Reuse only this workspace's dev server; never stop a listener or fall through on an occupied foreign port. */
export async function reuseDevelopmentWeb(root,transport=fetch){
  let response;
  try{response=await transport('http://127.0.0.1:1420/__inbora_dev_instance',
    {redirect:'error',signal:AbortSignal.timeout(1500)});}
  catch(error){if(error?.cause?.code==='ECONNREFUSED')return false;throw new Error('DEV_WEB_SERVER_UNAVAILABLE');}
  if(!response.ok||!response.headers.get('content-type')?.startsWith('application/json')||!response.body)
    throw new Error('DEV_PORT_1420_BELONGS_TO_ANOTHER_SERVER');
  const reader=response.body.getReader(),chunks=[];let length=0;
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.length;
    if(length>512)throw new Error('DEV_PORT_1420_BELONGS_TO_ANOTHER_SERVER');chunks.push(chunk.value);}}
  finally{await reader.cancel().catch(()=>{});}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw new Error('DEV_PORT_1420_BELONGS_TO_ANOTHER_SERVER');}
  const workspace=createHash('sha256').update(resolve(join(root,'desktop'))).digest('hex');
  if(value?.application!=='inbora-development'||value.workspace!==workspace)
    throw new Error('DEV_PORT_1420_BELONGS_TO_ANOTHER_SERVER');
  return true;
}
