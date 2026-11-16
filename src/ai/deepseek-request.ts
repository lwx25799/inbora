import {z} from 'zod';
import {requireSafe} from '../core/contracts.js';

const responseSchema=z.object({model:z.string().min(1),choices:z.array(z.object({index:z.number().int(),
  finish_reason:z.literal('stop'),message:z.object({role:z.literal('assistant'),content:z.string(),
    tool_calls:z.array(z.unknown()).max(0).optional()})})).length(1),
  usage:z.object({prompt_tokens:z.number().int().nonnegative(),completion_tokens:z.number().int().nonnegative(),
    total_tokens:z.number().int().nonnegative()})});
export interface DeepSeekRequest {model:string;key:string;system:string;data:unknown;maximumTokens:512|2048;signal?:AbortSignal}

/** The existing official endpoint and response contract; a request never retries or changes providers. */
export async function requestDeepSeek(transport:typeof fetch,input:DeepSeekRequest){
  requireSafe(input.key.length>0&&!/[\r\n]/u.test(input.key),'INVALID_MODEL_KEY');
  requireSafe(!input.signal?.aborted,'MODEL_CANCELLED');
  const response=await transport('https://api.deepseek.com/chat/completions',{
    method:'POST',redirect:'error',signal:input.signal?AbortSignal.any([input.signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000),
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.key}`},
    body:JSON.stringify({model:input.model,stream:false,max_tokens:input.maximumTokens,thinking:{type:'disabled'},
      messages:[{role:'system',content:input.system},{role:'user',content:JSON.stringify(input.data)}]})});
  requireSafe(response.ok&&response.body,'MODEL_HTTP_ERROR');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.byteLength;
    requireSafe(length<=64_000,'MODEL_RESPONSE_TOO_LARGE');chunks.push(chunk.value);}}
  finally{await reader.cancel().catch(()=>{});}
  const result=responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  requireSafe(result.model===input.model||result.model.startsWith(`${input.model}-`),'MODEL_CHANGED');
  requireSafe(result.usage.prompt_tokens+result.usage.completion_tokens===result.usage.total_tokens&&
    result.usage.completion_tokens<=input.maximumTokens,'MODEL_USAGE_INVALID');
  return{text:result.choices[0]!.message.content,model:result.model,inputTokens:result.usage.prompt_tokens,
    outputTokens:result.usage.completion_tokens};
}
