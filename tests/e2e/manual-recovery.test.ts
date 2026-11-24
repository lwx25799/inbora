import {afterAll,beforeAll,expect,test,vi} from 'vitest';
import {chromium,type Browser} from 'playwright';
import {AccountActor} from '../../src/browser/account-actor.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ManualRecovery,type ManualRecoveryOptions} from '../../src/browser/manual-recovery.js';
import {manualRecoveryCommandSchema,type ManualRecoveryFrame} from '../../src/app/manual-recovery-contracts.js';

let browser:Browser;
beforeAll(async()=>{browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});});
afterAll(async()=>{await browser.close();});
const noop=()=>{};
async function fixture(){
  const context=await browser.newContext({viewport:{width:1280,height:720}});
  await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:route.request().url().startsWith('https://challenge.invalid')?
    `<style>body{margin:0}input{position:absolute;left:20px;top:20px}button{position:absolute;left:20px;top:70px}</style>
    <input id="code"><button onclick="this.dataset.clicked='yes'">Synthetic verification</button>`:
    `<style>body{margin:0}#captcha{position:fixed;inset:0}iframe{position:absolute;left:450px;top:186px;width:380px;height:348px;border:0}</style>
    <input id="draft" value="preserved human draft"><div id="captcha"><iframe src="https://challenge.invalid/"></iframe></div>`}));
  const notification=await context.newPage(),dm=await context.newPage();
  await notification.goto('https://fixture.invalid/work');
  await notification.locator('iframe').waitFor();
  await notification.frameLocator('iframe').locator('#code').waitFor();
  const owner={actor:new AccountActor(),notification,dm} as BrowserProfileOwner;
  let closed=0;
  const recovery=new ManualRecovery(()=>{closed++;});
  const document=await notification.evaluate(()=>({href:location.href,started:performance.timeOrigin}));
  const options:ManualRecoveryOptions={channel:'COMMENT_NOTIFICATION',epoch:1,incidentId:'synthetic-incident',revision:'synthetic-hold',
    document,selectors:['#captcha'],check:noop};
  return{context,owner,page:notification,recovery,options,get closed(){return closed;},
    async cleanup(){await recovery.shutdown();await context.close();}};
}
async function click(recovery:ManualRecovery,frame:ManualRecoveryFrame,x:number,y:number,sequence:number){
  await recovery.input(frame.sessionId,frame.frameId,sequence,{kind:'pointer',phase:'down',x,y},noop);
  await recovery.input(frame.sessionId,frame.frameId,sequence+1,{kind:'pointer',phase:'up',x,y},noop);
}
async function tick(){await new Promise<void>(done=>setImmediate(done));}

test('the original headless page stays reserved while its challenge accepts human pointer and text',async()=>{
  const f=await fixture();
  try{
    const session=await f.recovery.start(f.owner,f.options);
    let competing=false;const queued=f.owner.actor.run(async()=>{competing=true;});
    await tick();expect(competing).toBe(false);
    const frame=await f.recovery.frame(session.sessionId,noop);
    expect(frame.regions).toEqual([{x:450,y:186,width:380,height:348}]);
    expect(frame.image).toMatch(/^data:image\/jpeg;base64,/u);expect(frame.documentPreserved).toBe(true);
    await click(f.recovery,frame,480,215,1);
    await f.recovery.input(session.sessionId,frame.frameId,3,{kind:'text',text:'123456'},noop);
    expect(await f.page.frameLocator('iframe').locator('#code').inputValue()).toBe('123456');
    await click(f.recovery,frame,490,270,4);
    expect(await f.page.frameLocator('iframe').locator('button').getAttribute('data-clicked')).toBe('yes');
    expect(await f.page.locator('#draft').inputValue()).toBe('preserved human draft');
    expect(await f.page.evaluate(()=>performance.timeOrigin)).toBe(f.options.document.started);
    await f.recovery.close(session.sessionId,noop);await queued;
    expect(competing).toBe(true);expect(f.closed).toBe(1);
  }finally{await f.cleanup();}
});

test('viewport security shells do not authorize clicking the underlying page or keyboard shortcuts',async()=>{
  const f=await fixture();
  try{
    const session=await f.recovery.start(f.owner,f.options),frame=await f.recovery.frame(session.sessionId,noop);
    await expect(f.recovery.input(session.sessionId,frame.frameId,1,{kind:'pointer',phase:'down',x:10,y:10},noop))
      .rejects.toThrow('MANUAL_RECOVERY_INPUT_OUTSIDE_CHALLENGE');
    await f.page.locator('#draft').focus();
    await expect(f.recovery.input(session.sessionId,frame.frameId,2,{kind:'text',text:'not allowed'},noop))
      .rejects.toThrow('MANUAL_RECOVERY_FOCUS_REQUIRED');
    expect(manualRecoveryCommandSchema.safeParse({command:'securityRecovery',action:'input',sessionId:session.sessionId,
      frameId:frame.frameId,sequence:3,input:{kind:'key',key:'Control+R'}}).success).toBe(false);
    expect(await f.page.locator('#draft').inputValue()).toBe('preserved human draft');
  }finally{await f.cleanup();}
});

test('retained DOM element handles reject challenge replacement and stale screen geometry',async()=>{
  const f=await fixture();
  try{
    const session=await f.recovery.start(f.owner,f.options),first=await f.recovery.frame(session.sessionId,noop);
    await f.page.locator('iframe').evaluate(frame=>{const clone=frame.cloneNode(true);frame.replaceWith(clone);});
    await f.page.frameLocator('iframe').locator('#code').waitFor();
    await expect(f.recovery.input(session.sessionId,first.frameId,1,{kind:'pointer',phase:'down',x:480,y:215},noop))
      .rejects.toThrow('MANUAL_RECOVERY_INPUT_OUTSIDE_CHALLENGE');
    const second=await f.recovery.frame(session.sessionId,noop);
    await f.page.locator('iframe').evaluate(frame=>{(frame as HTMLElement).style.left='600px';});
    await expect(f.recovery.input(session.sessionId,second.frameId,2,{kind:'pointer',phase:'down',x:480,y:215},noop))
      .rejects.toThrow('MANUAL_RECOVERY_INPUT_OUTSIDE_CHALLENGE');
    const third=await f.recovery.frame(session.sessionId,noop);
    await click(f.recovery,third,630,215,3);
  }finally{await f.cleanup();}
});

test('earlier displayed frames remain usable until expiry and input sequences cannot replay',async()=>{
  const f=await fixture();
  try{
    const session=await f.recovery.start(f.owner,f.options),first=await f.recovery.frame(session.sessionId,noop);
    await f.recovery.frame(session.sessionId,noop);await click(f.recovery,first,480,215,1);
    await expect(f.recovery.input(session.sessionId,first.frameId,2,{kind:'text',text:'duplicate'},noop))
      .rejects.toThrow('MANUAL_RECOVERY_INPUT_REPLAY');
    const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+11_000);
    await f.recovery.input(session.sessionId,first.frameId,3,{kind:'pointer',phase:'down',x:480,y:215},noop);
    await f.recovery.input(session.sessionId,first.frameId,4,{kind:'pointer',phase:'up',x:480,y:215},noop);
    vi.spyOn(Date,'now').mockReturnValue(now+13_000);
    await expect(f.recovery.input(session.sessionId,first.frameId,5,{kind:'text',text:'stale'},noop))
      .rejects.toThrow('MANUAL_RECOVERY_FRAME_EXPIRED');
    vi.restoreAllMocks();expect(f.recovery.active).toBe(true);
  }finally{vi.restoreAllMocks();await f.cleanup();}
});

test('an unavailable original document is never reopened, and navigation releases the reserved actor',async()=>{
  const f=await fixture();
  try{
    await expect(f.recovery.start(f.owner,{...f.options,document:{...f.options.document,started:1}}))
      .rejects.toThrow('MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE');
    expect(f.recovery.active).toBe(false);
    const session=await f.recovery.start(f.owner,f.options);
    await f.page.goto('https://fixture.invalid/different');
    await f.owner.actor.run(async()=>{});
    expect(f.recovery.active).toBe(false);expect(f.closed).toBe(1);
    await expect(f.recovery.frame(session.sessionId,noop)).rejects.toThrow('MANUAL_RECOVERY_SESSION_EXPIRED');
    expect(f.page.url()).toBe('https://fixture.invalid/different');
  }finally{await f.cleanup();}
});

test('verification runs inside the lease and releases it even if verification or authorization fails',async()=>{
  const f=await fixture();
  try{
    const session=await f.recovery.start(f.owner,f.options);let competing=false;
    const queued=f.owner.actor.run(async()=>{competing=true;});
    await expect(f.recovery.finish(session.sessionId,noop,async()=>{
      expect(competing).toBe(false);throw Error('synthetic verification remains blocked');
    })).rejects.toThrow('synthetic verification remains blocked');
    await queued;expect(f.recovery.active).toBe(false);expect(f.closed).toBe(1);
    const next=await f.recovery.start(f.owner,f.options);
    await expect(f.recovery.frame(next.sessionId,()=>{throw Error('revoked');})).rejects.toThrow('revoked');
    await f.owner.actor.run(async()=>{});expect(f.recovery.active).toBe(false);expect(f.closed).toBe(2);
  }finally{await f.cleanup();}
});

test('a human drag can span screenshot refreshes without releasing the pointer early',async()=>{
  const f=await fixture();
  try{
    await f.page.frameLocator('iframe').locator('button').evaluate(button=>{
      button.addEventListener('pointerdown',()=>{button.setAttribute('data-down','yes');});
      button.addEventListener('pointerup',event=>{button.setAttribute('data-up',String((event as PointerEvent).buttons));});
    });
    const session=await f.recovery.start(f.owner,f.options),first=await f.recovery.frame(session.sessionId,noop);
    await f.recovery.input(session.sessionId,first.frameId,1,{kind:'pointer',phase:'down',x:490,y:270},noop);
    const second=await f.recovery.frame(session.sessionId,noop);
    await f.recovery.input(session.sessionId,second.frameId,2,{kind:'pointer',phase:'move',x:510,y:270},noop);
    await f.recovery.input(session.sessionId,second.frameId,3,{kind:'pointer',phase:'up',x:510,y:270},noop);
    expect(await f.page.frameLocator('iframe').locator('button').getAttribute('data-down')).toBe('yes');
    expect(await f.page.frameLocator('iframe').locator('button').getAttribute('data-up')).toBe('0');
  }finally{await f.cleanup();}
});

test('a challenge iframe navigation invalidates old input frames while preserving the original outer document',async()=>{
  const f=await fixture();
  try{
    const session=await f.recovery.start(f.owner,f.options),first=await f.recovery.frame(session.sessionId,noop);
    const child=f.page.frames().find(frame=>frame.parentFrame());expect(child).toBeDefined();
    await child!.goto('https://challenge.invalid/replacement');
    await expect(f.recovery.input(session.sessionId,first.frameId,1,{kind:'pointer',phase:'down',x:490,y:270},noop))
      .rejects.toThrow('MANUAL_RECOVERY_INPUT_OUTSIDE_CHALLENGE');
    const second=await f.recovery.frame(session.sessionId,noop);
    await click(f.recovery,second,490,270,2);
    expect(await f.page.evaluate(()=>performance.timeOrigin)).toBe(f.options.document.started);
    expect(f.recovery.active).toBe(true);
  }finally{await f.cleanup();}
});

test('idle expiry and revoked close both release the actor and pressed pointer exactly once',async()=>{
  const f=await fixture();
  try{
    const session=await f.recovery.start(f.owner,f.options),frame=await f.recovery.frame(session.sessionId,noop);
    await f.recovery.input(session.sessionId,frame.frameId,1,{kind:'pointer',phase:'down',x:490,y:270},noop);
    const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+301_000);
    await new Promise(done=>setTimeout(done,1100));vi.restoreAllMocks();
    await f.owner.actor.run(async()=>{});expect(f.recovery.active).toBe(false);expect(f.closed).toBe(1);
    const next=await f.recovery.start(f.owner,f.options);
    await expect(f.recovery.close(next.sessionId,()=>{throw Error('revoked');})).rejects.toThrow('revoked');
    await f.owner.actor.run(async()=>{});expect(f.recovery.active).toBe(false);expect(f.closed).toBe(2);
  }finally{vi.restoreAllMocks();await f.cleanup();}
});

test('successful in-place verification can consume its exact hold and cannot close a different session',async()=>{
  const f=await fixture();let held=true;
  try{
    const session=await f.recovery.start(f.owner,{...f.options,check:()=>{if(!held)throw Error('hold changed');}});
    await expect(f.recovery.close('00000000-0000-4000-8000-000000000000',noop)).rejects.toThrow('MANUAL_RECOVERY_SESSION_EXPIRED');
    expect(f.recovery.active).toBe(true);
    await f.recovery.finish(session.sessionId,noop,async()=>{held=false;});
    expect(f.recovery.active).toBe(false);expect(f.closed).toBe(1);
    await f.owner.actor.run(async()=>{});
  }finally{await f.cleanup();}
});

test('GUI reconnect rotates its token and rejects already queued old frame, input, finish and close commands',async()=>{
  const f=await fixture();
  try{
    const first=await f.recovery.start(f.owner,f.options),screen=await f.recovery.frame(first.sessionId,noop);
    await f.recovery.input(first.sessionId,screen.frameId,1,{kind:'pointer',phase:'down',x:490,y:270},noop);
    let verified=false;
    const reconnect=f.recovery.resume(noop);
    const stale=Promise.allSettled([
      f.recovery.frame(first.sessionId,noop),
      f.recovery.input(first.sessionId,screen.frameId,2,{kind:'pointer',phase:'up',x:490,y:270},noop),
      f.recovery.finish(first.sessionId,noop,async()=>{verified=true;}),
      f.recovery.close(first.sessionId,noop),
    ]);
    const resumed=await reconnect;
    expect(resumed.sessionId).not.toBe(first.sessionId);
    expect((await stale).map(result=>result.status)).toEqual(['rejected','rejected','rejected','rejected']);
    expect(verified).toBe(false);expect(f.recovery.active).toBe(true);expect(f.closed).toBe(0);
    const fresh=await f.recovery.frame(resumed.sessionId,noop);
    await click(f.recovery,fresh,480,215,1);
    expect(await f.page.evaluate(()=>performance.timeOrigin)).toBe(f.options.document.started);
    await expect(f.recovery.input(resumed.sessionId,screen.frameId,3,{kind:'text',text:'old screen'},noop))
      .rejects.toThrow('MANUAL_RECOVERY_FRAME_EXPIRED');
    await f.recovery.close(resumed.sessionId,noop);expect(f.closed).toBe(1);
  }finally{await f.cleanup();}
});

test('a deferred successful verification commits only after original-document and hold checks still pass',async()=>{
  const f=await fixture();let held=true,committed=false;
  try{
    const session=await f.recovery.start(f.owner,{...f.options,check:()=>{if(!held)throw Error('hold changed');}});
    await f.recovery.finish(session.sessionId,noop,async()=>()=>{committed=true;held=false;});
    expect(committed).toBe(true);expect(held).toBe(false);expect(f.recovery.active).toBe(false);
  }finally{await f.cleanup();}
});

test('navigation or hold changes during verification prevent deferred hold consumption and release the lease',async()=>{
  for(const failure of ['document','hold'] as const){
    const f=await fixture();let held=true,committed=false;
    try{
      const session=await f.recovery.start(f.owner,{...f.options,check:()=>{if(!held)throw Error('hold changed');}});
      await expect(f.recovery.finish(session.sessionId,noop,async()=>{
        if(failure==='document')await f.page.goto('https://fixture.invalid/changed');
        else held=false;
        return()=>{committed=true;};
      })).rejects.toThrow();
      expect(committed).toBe(false);expect(f.recovery.active).toBe(false);expect(f.closed).toBe(1);
      await f.owner.actor.run(async()=>{});
    }finally{await f.cleanup();}
  }
});

test('the watchdog releases the actor when the saved authority is revoked without another GUI command',async()=>{
  const f=await fixture();let permitted=true;
  try{
    const session=await f.recovery.start(f.owner,{...f.options,check:()=>{if(!permitted)throw Error('revoked');}});
    const screen=await f.recovery.frame(session.sessionId,noop);
    await f.recovery.input(session.sessionId,screen.frameId,1,{kind:'pointer',phase:'down',x:490,y:270},noop);
    permitted=false;await new Promise(done=>setTimeout(done,1100));
    await f.owner.actor.run(async()=>{});
    expect(f.recovery.active).toBe(false);expect(f.closed).toBe(1);
  }finally{await f.cleanup();}
});
