import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OwnerLock } from '../../src/browser/owner-lock.js';
import { readAssistantDiscovery, discoveryFilename } from '../../src/mcp/discovery.js';
import { privateTemp } from '../helpers.js';

test.each(['init', 'runtime', 'client', 'automation', 'settings', 'control', 'request'])(
  'EOF during accepted %s work safely closes the service and releases the real runtime lock', async phase => {
    const folder = privateTemp('sidecar-close-'), runtime = join(folder, 'runtime');
    const trace = join(folder, 'trace.txt'), release = join(folder, 'release');
    const fixture = join(folder, 'connection-fixture.ts'), entry = join(folder, 'sidecar-under-test.ts');
    const url = (file: string) => pathToFileURL(resolve(file)).href;
    await writeFile(fixture, `
      import {EventEmitter} from 'node:events';
      import {appendFileSync,existsSync} from 'node:fs';
      import {resolve} from 'node:path';
      import {OwnerLock as RealLock} from ${JSON.stringify(url('src/browser/owner-lock.ts'))};
      import {EventStore as RealStore} from ${JSON.stringify(url('src/storage/store.ts'))};
      import {startAssistantControl as realControl} from ${JSON.stringify(url('src/mcp/control-server.ts'))};
      const trace=${JSON.stringify(trace)}, release=${JSON.stringify(release)}, phase=${JSON.stringify(phase)};
      const note=(value:string)=>appendFileSync(trace,value+'\\n');
      process.stdin.once('end',()=>note('stdin.end'));
      async function gate(stage:string){
        note('enter.'+stage);
        if(stage===phase){
          process.stdout.write(JSON.stringify({fixtureGate:stage})+'\\n');
          while(!existsSync(release))await new Promise(resolve=>setTimeout(resolve,5));
        }
        note('leave.'+stage);
      }
      export class OwnerLock {
        static async acquire(directory:string,create:boolean){
          const lock=await RealLock.acquire(directory,create);note('lock.acquired');
          return {async close(){note('lock.close');await lock.close();}};
        }
      }
      export class EventStore extends RealStore {override close(){note('store.close');super.close();}}
      export const runtimeRoot=(value:string)=>resolve(value);
      export const initRuntime=()=>gate('init'),loadRuntime=()=>gate('runtime');
      export const migrateClient=()=>gate('client'),migrateAutomation=()=>gate('automation');
      export class BrowserService {constructor(readonly root:string){note('browser.created');}}
      export class ClientService {
        statuses=0;cancelRequest:(()=>void)|undefined;
        events=new EventEmitter();
        authority={issueSession:()=> 'synthetic-session',operator:()=>({}),expireOperators(){},renewTrustedSession(){},revoke(){}};
        constructor(_store:unknown,readonly browser:BrowserService){note('service.created');}
        loadSettings(){return gate('settings');}
        startOnline(){note('service.online');}
        setAssistantConnection(instanceId:string|null){note(instanceId?'assistant.ready':'assistant.offline');}
        async dispatch(){
          note('service.status');
          if(phase==='request'&&++this.statuses===2){
            process.stdout.write(JSON.stringify({fixtureGate:'request'})+'\\n');
            await new Promise<void>(resolve=>{this.cancelRequest=resolve;});
            note('request.cancelled');throw new Error('CLIENT_CLOSING');
          }
          return{schema:3};
        }
        async close(){note('service.close');this.cancelRequest?.();}
      }
      export class AssistantFacade {
        instanceId='';
        constructor(_service:ClientService){note('assistant.created');}
        async dispatch(){return {};}
        async close(){note('assistant.close');}
      }
      export async function startAssistantControl(options:Parameters<typeof realControl>[0]){
        const control=await realControl(options);note('control.started');
        await gate('control');
        return {...control,async close(){note('control.close.begin');await control.close();note('control.closed');}};
      }
      export const clientError=(error:unknown)=>error instanceof Error?error.message:'SYNTHETIC_FAILURE';
    `);
    const fixtures = new Set(['../browser/owner-lock.js', '../storage/store.js', '../storage/client-migration.js',
      '../storage/automation-migration.js', '../config/runtime.js', './browser-service.js', './service.js',
      '../mcp/assistant-facade.js','../mcp/control-server.js']);
    const source = (await readFile('src/app/sidecar.ts', 'utf8')).replace(/from (['"])(\.[^'"]+)\1/gu, (_match, _quote: string, specifier: string) =>
      `from ${JSON.stringify(fixtures.has(specifier) ? url(fixture) : url(resolve('src/app', specifier.replace(/\.js$/u, '.ts'))))}`);
    await writeFile(entry, source);
    const secret = randomBytes(32).toString('hex');
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: resolve('.'), env: { ...process.env, INBORA_PIPE_NONCE: secret }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const messages: Record<string, unknown>[] = [];
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => messages.push(JSON.parse(line) as Record<string, unknown>));
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    let guard: OwnerLock | undefined;
    try {
      await expect.poll(() => messages.some(item => item.ready === true), { message: stderr }).toBe(true);
      child.stdin.write(JSON.stringify({ protocol: 1, requestId: randomUUID(), secret,
        body: { command: 'connect', runtime, initialize: true, consent: true } }) + '\n');
      if (phase === 'request') {
        await expect.poll(() => messages.some(item => item.ok === true)).toBe(true);
        child.stdin.write(JSON.stringify({ protocol: 1, requestId: randomUUID(), secret, body: { command: 'getStatus' } }) + '\n');
      }
      await expect.poll(() => messages.some(item => item.fixtureGate === phase)).toBe(true);
      if (phase === 'control' || phase === 'request') {
        const discovery=await readAssistantDiscovery(runtime);
        expect(discovery).toMatchObject({runtime,pid:child.pid});
        expect(discovery.port).toBeGreaterThan(0);
      }
      await expect(OwnerLock.acquire(runtime, false)).rejects.toThrow('OWNER_LOCKED_OR_PORT_UNAVAILABLE');
      child.stdin.end();
      await expect.poll(async () => (await readFile(trace, 'utf8')).includes('stdin.end')).toBe(true);
      await writeFile(release, 'release synthetic connection work');
      expect(await exited, stderr).toBe(0);
      const stages = (await readFile(trace, 'utf8')).trim().split('\n');
      if (phase === 'request') {
        expect(stages.filter(stage => stage === 'service.online')).toHaveLength(1);
        expect(stages.indexOf('service.online')).toBeLessThan(stages.indexOf('stdin.end'));
        expect(stages.indexOf('request.cancelled')).toBeGreaterThan(stages.indexOf('service.close'));
      } else {
        expect(stages).not.toContain('service.online');
        expect(messages.filter(item => item.ok === true)).toEqual([]);
      }
      expect(messages.find(item => item.ok === false)).toMatchObject({ error: 'CLIENT_CLOSING' });
      if (phase === 'settings' || phase === 'control') {
        expect(stages.indexOf('service.close')).toBeGreaterThan(stages.indexOf('leave.settings'));
        expect(stages.indexOf('store.close')).toBeGreaterThan(stages.indexOf('service.close'));
      } else if (phase !== 'request') expect(stages).not.toContain('service.created');
      if(phase==='control'||phase==='request'){
        expect(stages.indexOf('control.started')).toBeGreaterThan(stages.indexOf('assistant.created'));
        expect(stages.indexOf('control.close.begin')).toBeLessThan(stages.indexOf('service.close'));
        expect(stages.indexOf('assistant.close')).toBeGreaterThan(stages.indexOf('service.close'));
        expect(stages.indexOf('control.closed')).toBeLessThan(stages.indexOf('store.close'));
      }
      await expect(readFile(join(runtime,discoveryFilename))).rejects.toMatchObject({code:'ENOENT'});
      guard = await OwnerLock.acquire(runtime, false);
    } finally {
      if (child.exitCode === null) { child.stdin.end(); child.kill(); }
      await exited; lines.close(); await guard?.close();
    }
  },
);
