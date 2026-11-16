import {expect,test} from 'vitest';
import {createServer} from 'vite';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const moduleUrl=pathToFileURL(resolve('scripts/dev-web-reuse.mjs')).href;
const {reuseDevelopmentWeb}=await import(moduleUrl) as {reuseDevelopmentWeb(root:string,transport?:typeof fetch):Promise<boolean>};

test('the development server identifies its exact workspace before a launcher may reuse its occupied port',async()=>{
  const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false},logLevel:'silent'});
  try{
    await server.listen();const address=server.httpServer!.address();if(!address||typeof address==='string')throw Error('NO_PORT');
    const response=await fetch(`http://127.0.0.1:${address.port}/__inbora_dev_instance`);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({application:'inbora-development',workspace:createHash('sha256').update(resolve('desktop')).digest('hex')});
  }finally{await server.close();}
});

test('launcher reuses the same workspace only and leaves a free port for normal Vite startup',async()=>{
  const root=resolve('.'),workspace=createHash('sha256').update(resolve('desktop')).digest('hex');
  let seen='';
  const existing:typeof fetch=async(url)=>{seen=String(url);return Response.json({application:'inbora-development',workspace});};
  expect(await reuseDevelopmentWeb(root,existing)).toBe(true);expect(seen).toBe('http://127.0.0.1:1420/__inbora_dev_instance');
  const absent:typeof fetch=async()=>{throw new TypeError('fetch failed',{cause:{code:'ECONNREFUSED'}});};
  expect(await reuseDevelopmentWeb(root,absent)).toBe(false);
  for(const response of [new Response('<html>foreign server</html>'),Response.json({application:'inbora-development',workspace:'other'}),
    Response.json({application:'foreign',workspace}),new Response('x'.repeat(513),{headers:{'content-type':'application/json'}})]){
    await expect(reuseDevelopmentWeb(root,async()=>response)).rejects.toThrow('DEV_PORT_1420_BELONGS_TO_ANOTHER_SERVER');
  }
  await expect(reuseDevelopmentWeb(root,async()=>{throw new Error('timeout');})).rejects.toThrow('DEV_WEB_SERVER_UNAVAILABLE');
});
