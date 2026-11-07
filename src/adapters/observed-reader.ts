import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { ObservationMapping } from '../config/site-mapping.js';
import { eventSchema, requireSafe, type InboundEvent } from '../core/contracts.js';

export interface DiscoveredPeer { uid: string | null; secUid: string; conversationId: string; title: string }
interface CaptureInput { mapping: ObservationMapping; channel: 'identity' | 'dm' | 'comments' | 'row' | 'locate' | 'conversations' | 'navigate' | 'back' | 'commentScroll'; index: number;
  evidenceId: string; rowIndex?: number; select?: boolean; scroll?: 'start' | 'next'; peer?: DiscoveredPeer; allCommentAuthors?: boolean; navigationUrl?: string; commentOffset?:number }
type CaptureOptions = Pick<CaptureInput,'rowIndex'|'select'|'scroll'|'peer'|'allCommentAuthors'>;
export interface ObservationBatch { events: InboundEvent[]; evidenceId: string; unsupported: number; loaded: number;
  conversation?: { rowIndex: number | null; hasList: boolean };
  peers?: DiscoveredPeer[];
  scroll?:{top:number;height:number;viewport:number;atEnd:boolean};
  bindings?: {targetKey: string; uid: string; secUid: string; title: string; conversationId: string | null}[] }

/** Fixed paths in the currently rendered, authorized components; never calls website functions or getters. */
export function captureObserved(input: CaptureInput): ObservationBatch {
  const { mapping: m, channel, index, evidenceId } = input; const s = m.selectors;
  const dom = {
    check(value: unknown, code: string): void { if (!value) throw new Error(code); },
    // Adapted from LockyBee chat-browser.mjs dataField; MIT notice in third_party/.
    // Reject unsupported descriptors explicitly instead of returning an absent value.
    data(object: unknown, key: string): unknown {
      if (!object || typeof object !== 'object') return undefined;
      const own = Object.getOwnPropertyDescriptor(object,key);
      const inherited = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object) ?? {},key);
      dom.check(!own || Object.hasOwn(own,'value'), 'RENDERED_ACCESSOR_UNSUPPORTED');
      dom.check(!inherited || Object.hasOwn(inherited,'value'), 'RENDERED_ACCESSOR_UNSUPPORTED');
      dom.check(!own || !inherited || own.value === inherited.value, 'RENDERED_FIELD_CONFLICT');
      return own ? own.value : inherited?.value;
    },
    visible(element: Element): boolean {
      if(!element.isConnected||!element.getClientRects().length)return false;
      for(let n:Element|null=element;n;n=n.parentElement){const style=getComputedStyle(n);
        if(style.visibility==='hidden'||style.visibility==='collapse'||style.display==='none'||Number(style.opacity)===0)return false;}
      return true;
    },
    one(root: Document | Element, selector: string): Element {
      const found = root.querySelectorAll(selector);
      dom.check(found.length > 0,'OBSERVATION_DOM_NOT_READY');
      dom.check(found.length === 1,'OBSERVATION_DOM_NOT_UNIQUE');
      dom.check(dom.visible(found[0]!),'OBSERVATION_DOM_NOT_READY'); return found[0]!;
    },
    ownedOne(root:Element,selector:string,requireVisible=true):Element{
      const found=Array.from(root.querySelectorAll(selector)).filter(n=>n.closest(s.commentRows)===root);
      dom.check(found.length>0,'OBSERVATION_DOM_NOT_READY');dom.check(found.length===1,'OBSERVATION_DOM_NOT_UNIQUE');
      dom.check(!requireVisible||dom.visible(found[0]!),'OBSERVATION_DOM_NOT_READY');return found[0]!;
    },
    react(element: Element, prefix: string): unknown {
      const keys = Object.getOwnPropertyNames(element).filter(key => key.startsWith(prefix));
      dom.check(keys.length === 1,'RENDERED_BINDING_UNAVAILABLE'); return dom.data(element,keys[0]!);
    },
    fiberProps(element: Element, depth: number): unknown {
      let fiber = dom.react(element,'__reactFiber$');
      for (let n = 0; n < depth; n++) fiber = dom.data(fiber,'return');
      return dom.data(fiber,'memoizedProps');
    },
    childProps(element: Element): unknown {
      const children = dom.data(dom.react(element,'__reactProps$'),'children');
      return dom.data(Array.isArray(children) ? dom.data(children,'0') : children,'props');
    },
    id(value: unknown): string | null { return typeof value === 'string' && /^\d{1,64}$/.test(value) ? value : null; },
    conversationId(conversation: unknown): string {
      const first=dom.data(conversation,'conversationId'), second=dom.data(conversation,'id');
      dom.check(first !== undefined || second !== undefined,'OBSERVATION_METADATA_NOT_READY');
      for(const value of [first,second]) if(value !== undefined)
        dom.check(typeof value==='string' && value.length>0 && value.length<=512,'OBSERVATION_CONVERSATION_ID_CONFLICT');
      dom.check(first===undefined || second===undefined || first===second,'OBSERVATION_CONVERSATION_ID_CONFLICT');
      return (first ?? second) as string;
    },
    rowIdentity(row: Element, peer: DiscoveredPeer): void {
      dom.check(row.isConnected && dom.visible(row),'OBSERVATION_ROW_UNAVAILABLE');
      const conversation=dom.data(dom.fiberProps(row,s.conversationFiberDepth),'conversation');
      dom.check(dom.conversationId(conversation)===peer.conversationId &&
        dom.data(conversation,'_toParticipantSecUserId')===peer.secUid,'OBSERVATION_ROW_IDENTITY_CONFLICT');
      dom.check(dom.one(row,s.conversationTitle).textContent?.trim()===peer.title,'OBSERVATION_METADATA_NOT_READY');
    },
    emptyEditors():void {
      for(const editor of Array.from(document.querySelectorAll('[contenteditable="true"],textarea,input'))) {
        if(!dom.visible(editor)||editor instanceof HTMLInputElement&&!['text','search','email','url','tel','password'].includes(editor.type))continue;
        const text=editor instanceof HTMLInputElement||editor instanceof HTMLTextAreaElement?editor.value:editor.textContent??'';
        dom.check(!editor.querySelector('img,video,audio,iframe,object,input,[data-slate-void="true"],[data-attachment]'),'OBSERVATION_EXISTING_HUMAN_INPUT');
        const marker=editor.matches('[data-slate-editor="true"][data-zone-container="*"]')&&
          editor.children.length===1&&editor.firstElementChild?.matches('div.ace-line[data-node="true"]')&&
          editor.firstElementChild.children.length===1&&editor.firstElementChild.firstElementChild?.matches('span[data-enter="true"][data-string="true"][data-leaf="true"]')&&text==='\u200B';
        dom.check(text.length===0||marker,'OBSERVATION_EXISTING_HUMAN_INPUT');
        dom.check(Array.from(editor.querySelectorAll('*')).every(node=>['DIV','P','SPAN','BR','B','I','EM','STRONG','U','S'].includes(node.tagName)),
          'OBSERVATION_EXISTING_HUMAN_INPUT');
      }
    },
    time(value: unknown, seconds: boolean): string | null {
      let time = NaN;
      if (seconds && typeof value === 'number' && Number.isFinite(value)) time = value * 1000;
      else if (!seconds) { try { time = Date.prototype.getTime.call(value); } catch { /* no date evidence */ } }
      return Number.isFinite(time) && time >= Date.UTC(2000,0,1) && time <= Date.now() ? new Date(time).toISOString() : null;
    },
  };
  dom.check(location.origin === m.origin && !/验证码|安全验证/.test(document.title), 'OBSERVATION_PAGE_BLOCKED');
  dom.check(!Array.from(document.querySelectorAll(m.securityBlockers)).some(dom.visible),'OBSERVATION_PAGE_BLOCKED');
  const avatar = dom.one(document,s.selfAvatar), own = dom.fiberProps(avatar,s.selfFiberDepth);
  dom.check(dom.data(own,'uid') === m.self.uid && dom.data(own,'secUid') === m.self.secUid,'OBSERVATION_ACCOUNT_CHANGED');
  const events: InboundEvent[] = []; let unsupported = 0, loaded = 0;
  const bindings: NonNullable<ObservationBatch['bindings']> = [];
  if (channel === 'identity') return { events,evidenceId,unsupported,loaded };
  if(channel==='navigate') {
    const url=new URL(input.navigationUrl!);
    dom.check(url.origin===m.origin&&!url.username&&!url.password&&!url.hash&&
      (m.works.some(w=>w.url===url.href)||url.pathname===`/user/${m.self.secUid}`),'OBSERVATION_WORK_CHANGED');
    dom.emptyEditors();location.assign(url.href);
    return {events,evidenceId,unsupported,loaded};
  }
  if(channel==='back') {
    dom.emptyEditors();
    const back=dom.one(document,s.chatBack);
    dom.check(back instanceof HTMLElement,'OBSERVATION_DOM_NOT_READY');(back as HTMLElement).click();
    return {events,evidenceId,unsupported,loaded};
  }
  if(channel==='commentScroll') {
    dom.emptyEditors();
    const lists=Array.from(document.querySelectorAll(s.commentList)).filter(dom.visible);dom.check(lists.length===1,'OBSERVATION_DOM_NOT_UNIQUE');
    let list=lists[0]!,found=false;
    for(let node:Element|null=list,depth=0;node&&depth<5;node=node.parentElement,depth++)if(/auto|scroll/.test(getComputedStyle(node).overflowY)&&node.scrollHeight>node.clientHeight){list=node;found=true;break;}
    if(!found)list=document.scrollingElement??list;
    dom.check(list.clientHeight>0,'OBSERVATION_DOM_NOT_READY');
    const before=list.scrollTop,maximum=Math.max(0,list.scrollHeight-list.clientHeight);
    list.scrollTop=input.commentOffset!==undefined?Math.min(maximum,input.commentOffset):Math.min(maximum,before+Math.max(1,Math.floor(list.clientHeight*0.8)));
    return {events,evidenceId,unsupported,loaded,scroll:{top:list.scrollTop,height:list.scrollHeight,viewport:list.clientHeight,atEnd:list.scrollTop>=maximum-1}};
  }
  if(channel==='conversations') {
    const panel=dom.one(document,s.dmPanel),list=s.conversationList?dom.one(panel,s.conversationList):null;
    const rows=Array.from(panel.querySelectorAll(s.conversationRows)).filter(row=>dom.visible(row)&&(!list||list.contains(row)));
    dom.check(rows.length<=100,'OBSERVATION_WINDOW_TOO_LARGE');
    const peers:DiscoveredPeer[]=[];
    for(const row of rows) {
      const native=dom.data(dom.fiberProps(row,s.conversationFiberDepth),'conversation');
      const id=dom.conversationId(native),secure=dom.data(native,'_toParticipantSecUserId');
      // A direct conversation must expose a stable peer secure ID; groups/unsupported rows remain unselected.
      if(typeof secure!=='string'||!secure||secure.length>300||secure===m.self.secUid){unsupported++;continue;}
      const title=dom.one(row,s.conversationTitle).textContent?.trim();
      dom.check(title,'OBSERVATION_METADATA_NOT_READY');
      const known=m.peers.find(p=>p.conversationId===id&&p.secUid===secure);
      peers.push({uid:known?.uid??null,secUid:secure,conversationId:id,title:title!});
    }
    dom.check(new Set(peers.map(p=>p.conversationId)).size===peers.length,'OBSERVATION_CONVERSATION_NOT_UNIQUE');
    if(list&&input.scroll)list.scrollTop=input.scroll==='start'||list.scrollTop+list.clientHeight>=list.scrollHeight-1?0:
      Math.min(list.scrollHeight-list.clientHeight,list.scrollTop+Math.max(1,Math.floor(list.clientHeight*0.8)));
    return {events,evidenceId,unsupported,loaded:rows.length,peers};
  } else if(channel==='locate') {
    const peer=input.peer??m.peers[index];dom.check(peer,'OBSERVATION_PEER_REQUIRED');
    const panel=dom.one(document,s.dmPanel),list=s.conversationList?dom.one(panel,s.conversationList):null;
    const rows=document.querySelectorAll(s.conversationRows),matches:number[]=[];
    for(let n=0;n<rows.length;n++) {
      const row=rows[n]!;
      if(!panel.contains(row)||!dom.visible(row)||(list&&!list.contains(row)))continue;
      loaded++;dom.check(loaded<=100,'OBSERVATION_WINDOW_TOO_LARGE');
      const native=dom.data(dom.fiberProps(row,s.conversationFiberDepth),'conversation');
      if(dom.conversationId(native)===peer!.conversationId && dom.data(native,'_toParticipantSecUserId')===peer!.secUid)matches.push(n);
    }
    dom.check(loaded>0,'OBSERVATION_DOM_NOT_READY');
    dom.check(matches.length<=1,'OBSERVATION_CONVERSATION_NOT_UNIQUE');
    if(matches.length)dom.rowIdentity(rows[matches[0]!]!,peer!);
    else if(list && input.scroll) {
      // Only the calibrated list is moved; no contact bodies or private application state are traversed.
      list.scrollTop=input.scroll==='start'?0:Math.min(list.scrollHeight-list.clientHeight,
        list.scrollTop+Math.max(1,Math.floor(list.clientHeight*0.8)));
    }
    return {events,evidenceId,unsupported,loaded,conversation:{rowIndex:matches[0]??null,hasList:Boolean(list)}};
  } else if(channel==='row') {
    const peer=input.peer??m.peers[index], rows=document.querySelectorAll(s.conversationRows);
    dom.check(peer && Number.isInteger(input.rowIndex) && input.rowIndex!>=0 && input.rowIndex!<rows.length,'OBSERVATION_ROW_REQUIRED');
    const row=rows[input.rowIndex!]!;dom.rowIdentity(row,peer!);
    if(input.select) {
      const gate={accepted:false,blocked:false,
        handle(event: Event): void {
          if(event.currentTarget!==row)return;
          try { dom.rowIdentity(row,peer!);const current=dom.fiberProps(dom.one(document,s.selfAvatar),s.selfFiberDepth);
            dom.check(dom.data(current,'uid')===m.self.uid && dom.data(current,'secUid')===m.self.secUid,'OBSERVATION_ACCOUNT_CHANGED');
            gate.accepted=true;
          } catch {gate.blocked=true;event.preventDefault();event.stopImmediatePropagation();}
        },
      };
      const event=s.conversationSelectEvent;
      row.addEventListener(event,gate.handle,true);
      try {
        // One browser task binds the native UI selection event and final target capture.
        // No pointer/mouse sequence can open a different conversation before this check.
        dom.rowIdentity(row,peer!);
        row.dispatchEvent(new MouseEvent(event,{bubbles:true,cancelable:true,view:window,button:0,buttons:event==='mousedown'?1:0}));
        dom.check(gate.accepted&&!gate.blocked,'OBSERVATION_ROW_SELECTION_BLOCKED');
      } finally {row.removeEventListener(event,gate.handle,true);}
    }
    return {events,evidenceId,unsupported,loaded};
  } else if (channel === 'dm') {
    const peer = input.peer??m.peers[index]; dom.check(peer,'OBSERVATION_PEER_REQUIRED');
    const chat = dom.one(document,s.chat), header = dom.one(chat,s.chatHeader);
    const conversation = dom.data(dom.childProps(header),'conversation');
    const id = dom.conversationId(conversation);
    dom.check(id === peer!.conversationId && dom.data(conversation,'_toParticipantSecUserId') === peer!.secUid &&
      dom.one(chat,s.chatTitle).textContent?.trim() === peer!.title,'OBSERVATION_CONVERSATION_CHANGED');
    const rows = Array.from(chat.querySelectorAll(s.messages)).filter(dom.visible).filter(row=>!input.peer||row.getBoundingClientRect().bottom>0&&row.getBoundingClientRect().top<innerHeight); loaded = rows.length;
    dom.check(rows.length <= 100,'OBSERVATION_WINDOW_TOO_LARGE');
    // Unknown direct peers are bound by the same native conversation and the unique non-self message sender.
    // Do not derive a UID from a nickname or invent one from a local fingerprint.
    const senders=new Set(rows.map(row=>dom.data(dom.data(dom.childProps(row),'message'),'sender')).filter(sender=>sender!==m.self.uid));
    dom.check(senders.size<=1,'OBSERVATION_SENDER_UNVERIFIED');
    const discovered=Array.from(senders)[0],peerUid=peer!.uid??dom.id(discovered);
    if(peer!.uid&&discovered!==undefined)dom.check(discovered===peer!.uid,'OBSERVATION_SENDER_UNVERIFIED');
    if(peerUid)bindings.push({targetKey:`dm:${id}`,uid:peerUid,secUid:peer!.secUid,title:peer!.title,conversationId:id});
    for (const row of rows) {
      const message = dom.data(dom.childProps(row),'message');
      dom.check(dom.data(message,'conversationId') === id,'OBSERVATION_MESSAGE_CONVERSATION_CONFLICT');
      const sender = dom.data(message,'sender'), box = row.closest(s.messageBox);
      dom.check(box && (sender === m.self.uid || sender === peerUid),'OBSERVATION_SENDER_UNVERIFIED');
      let fromMe = false;
      for (let node: Element | null = row; node && box!.contains(node); node = node.parentElement)
        if (node.classList.contains(s.fromMeClass)) fromMe = true;
      dom.check(fromMe === (sender === m.self.uid),'OBSERVATION_DIRECTION_CONFLICT');
      const texts = row.querySelectorAll(s.messageText);
      if (texts.length !== 1 || texts[0]!.querySelector('img,video,audio')) { unsupported++; continue; }
      if(!dom.visible(texts[0]!))continue;
      const text = texts[0]!.textContent ?? '', parsed = dom.data(message,'_parsedContent');
      dom.check(text.length > 0 && text === dom.data(parsed,'text'),'OBSERVATION_MESSAGE_TEXT_CONFLICT');
      events.push({ accountId:'account_001',channel:'DIRECT_MESSAGE',platformEventId:dom.id(dom.data(message,'serverId')),
        actorId:sender as string,actorName:fromMe ? null : peer!.title,text,occurredAt:dom.time(dom.data(message,'createdAt'),false),
        videoId:null,commentId:null,conversationId:peer!.conversationId,direction:fromMe?'OUTGOING':'INCOMING',kind:'DM',
        evidenceId,discovery:'DIRECT_MESSAGE' });
    }
  } else {
    const work = m.works[index]; dom.check(work && location.href.split('?')[0] === work.url.split('?')[0], 'OBSERVATION_WORK_CHANGED');
      const lists=Array.from(document.querySelectorAll(s.commentList)).filter(dom.visible);
      dom.check(lists.length>0,'OBSERVATION_DOM_NOT_READY');dom.check(lists.length===1,'OBSERVATION_DOM_NOT_UNIQUE');
      const list=lists[0]!,rows = Array.from(list.querySelectorAll(s.commentRows)).filter(row=>!input.allCommentAuthors||
        row.getBoundingClientRect().bottom>Math.max(0,list.getBoundingClientRect().top)&&row.getBoundingClientRect().top<Math.min(innerHeight,list.getBoundingClientRect().bottom)); loaded = rows.length;
    dom.check(rows.length <= 100,'OBSERVATION_WINDOW_TOO_LARGE');
    const visibleRoots=rows.filter(row=>dom.visible(row)&&!row.parentElement?.closest(s.commentRows));
    const empty=s.commentEmpty?Array.from(list.querySelectorAll(s.commentEmpty)).filter(dom.visible):[];
    dom.check(visibleRoots.length>0||empty.length===1,'OBSERVATION_DOM_NOT_READY');
    for (const row of rows) {
      if (!dom.visible(row) || row.parentElement?.closest(s.commentRows)) continue;
      const authors = Array.from(row.querySelectorAll(s.commentAuthor)).filter(n=>n.closest(s.commentRows)===row&&dom.visible(n));
      const profiles = authors.map(a => a.getAttribute('href')).filter(Boolean).map(href => new URL(href!,location.origin));
      const knownPeer=[...m.peers,...m.commentAuthors??[]].find(p => profiles.some(url => url.origin === m.origin && url.pathname === `/user/${p.secUid}`));
      if(!input.allCommentAuthors&&!knownPeer)continue;
      const props = dom.fiberProps(row,s.commentFiberDepth), comment = dom.data(props,'commentInfo');
      const author = dom.data(comment,'user'), aweme = dom.data(props,'awemeInfo'), self = dom.data(props,'userInfo');
      dom.check(dom.data(aweme,'awemeId') === work!.id && dom.data(self,'uid') === m.self.uid,'OBSERVATION_COMMENT_WORK_CONFLICT');
      const nativeUid=dom.id(dom.data(author,'uid')),nativeSecure=dom.data(author,'secUid');
      const discoveredPeer=input.allCommentAuthors&&nativeUid&&typeof nativeSecure==='string'&&/^[A-Za-z0-9_-]{1,300}$/.test(nativeSecure)&&
        profiles.length===1&&profiles[0]!.origin===m.origin&&profiles[0]!.pathname===`/user/${nativeSecure}`
        ? {uid:nativeUid,secUid:nativeSecure,title:authors[0]!.textContent?.trim()??''}:null;
      if(input.allCommentAuthors)dom.check(discoveredPeer,'OBSERVATION_COMMENT_AUTHOR_UNVERIFIED');
      const peer = discoveredPeer??knownPeer;
      if (!peer) continue;
      dom.check(dom.data(author,'uid') === peer.uid && dom.data(author,'secUid') === peer.secUid,'OBSERVATION_COMMENT_AUTHOR_CONFLICT');
      const id = dom.id(dom.data(comment,'cid')), tooltip = dom.ownedOne(row,s.commentTooltip,false);
      dom.check(id && tooltip.id === `tooltip_${id}`,'OBSERVATION_COMMENT_ID_CONFLICT');
      const text = dom.ownedOne(row,s.commentText).textContent ?? '';
      dom.check(text.length > 0 && text === dom.data(comment,'text'),'OBSERVATION_COMMENT_TEXT_CONFLICT');
      bindings.push({targetKey:`comment:${work!.id}:${id}`,uid:peer.uid,secUid:peer.secUid,title:peer.title,conversationId:null});
      events.push({ accountId:'account_001',channel:'COMMENT_NOTIFICATION',platformEventId:id,actorId:peer.uid,
        actorName:peer.title,text,occurredAt:dom.time(dom.data(comment,'createTime'),true),occurredAtPrecisionMs:1000,videoId:work!.id,commentId:id,
        conversationId:null,direction:'INCOMING',kind:'COMMENT',evidenceId,discovery:'ALLOWED_WORK' });
    }
  }
  dom.check(new Set(events.map(e=>e.platformEventId).filter(Boolean)).size === events.filter(e=>e.platformEventId).length,
    'OBSERVATION_MESSAGE_ID_COLLISION');
  return { events,evidenceId,unsupported,loaded,bindings };
}

/** AccountActor owns the entire call, including opening and switching the permitted chat. */
export class ObservedReader {
  constructor(readonly page: Page, readonly mapping: ObservationMapping) {}
  private async capture(channel: CaptureInput['channel'], index: number, selection: CaptureOptions = {}): Promise<ObservationBatch> {
    try {
      const result = await this.page.evaluate(captureObserved,{mapping:this.mapping,channel,index,evidenceId:randomUUID(),...selection});
      return {...result,events:result.events.map(e=>eventSchema.parse(e))};
    } catch(error) {
      const code=error instanceof Error ? error.message.match(/(?:OBSERVATION|RENDERED)_[A-Z_]+/)?.[0] : null;
      if(code) requireSafe(false,code);throw error;
    }
  }
  private async ready(channel: CaptureInput['channel'],index: number,options:CaptureOptions={}): Promise<ObservationBatch> {
    const deadline=Date.now()+5000;
    for(;;)try{return await this.capture(channel,index,options);}catch(error){
      if(!(error instanceof Error)||!/(?:OBSERVATION_(?:DOM|METADATA)_NOT_READY|RENDERED_BINDING_UNAVAILABLE)/.test(error.message)||Date.now()>=deadline)throw error;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
  async guard(): Promise<void> {
    await this.page.waitForFunction(({selector,depth})=>{
      const nodes=document.querySelectorAll(selector); if(nodes.length!==1)return false;
      const keys=Object.getOwnPropertyNames(nodes[0]!).filter(k=>k.startsWith('__reactFiber$'));
      if(keys.length!==1)return false;
      let fiber=Object.getOwnPropertyDescriptor(nodes[0]!,keys[0]!)?.value;
      for(let n=0;n<depth;n++) {
        const descriptor=fiber&&Object.getOwnPropertyDescriptor(fiber,'return');
        if(!descriptor||!Object.hasOwn(descriptor,'value'))return false;fiber=descriptor.value;
      }
      const props=fiber&&Object.getOwnPropertyDescriptor(fiber,'memoizedProps')?.value;
      return props&&typeof Object.getOwnPropertyDescriptor(props,'uid')?.value==='string'&&
        typeof Object.getOwnPropertyDescriptor(props,'secUid')?.value==='string';
    },{selector:this.mapping.selectors.selfAvatar,depth:this.mapping.selectors.selfFiberDepth},{timeout:15000});
    await this.capture('identity',0);
  }
  async dm(index: number, discoveredPeer?: DiscoveredPeer): Promise<ObservationBatch> {
    const s = this.mapping.selectors, peer = discoveredPeer??this.mapping.peers[index]; requireSafe(peer,'OBSERVATION_PEER_REQUIRED');
    const options:CaptureOptions=discoveredPeer?{peer:discoveredPeer}:{};
    await this.guard();
    if (!await this.page.locator(s.dmPanel).isVisible()) await this.page.locator(s.dmEntry).click();
    await this.page.locator(s.dmPanel).waitFor({state:'visible'});
    const chat = this.page.locator(s.chat);
    if (await chat.isVisible()) {
      try { return await this.ready('dm',index,options); } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('OBSERVATION_CONVERSATION_CHANGED')) throw error;
        // A different visible chat must close normally before selecting another permitted row.
        if(discoveredPeer)await this.capture('back',index);
        else await this.page.locator(s.chatBack).click();
        await chat.waitFor({state:'hidden'});
      }
    }
    const deadline=Date.now()+12000;
    for(let step=0;step<80 && Date.now()<deadline;step++) {
      const batch=await this.ready('locate',index,{...options,scroll:step===0?'start':'next'}),found=batch.conversation!;
      if(found.rowIndex!==null) {
        // Virtualized rows may change between tasks; the selection task rechecks native identity.
        await this.ready('row',index,{...options,rowIndex:found.rowIndex,select:true});
        await chat.waitFor({state:'visible'});return this.ready('dm',index,options);
      }
      if(!found.hasList)break;
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    requireSafe(false,'OBSERVATION_CONVERSATION_NOT_FOUND');
  }
  async conversations(scroll?: 'start'|'next'):Promise<ObservationBatch> {
    await this.guard();
    const s=this.mapping.selectors;
    if(!await this.page.locator(s.dmPanel).isVisible())await this.page.locator(s.dmEntry).click();
    if(await this.page.locator(s.chat).isVisible())await this.capture('back',0);
    return this.ready('conversations',0,scroll?{scroll}:{});
  }
  async navigate(url:string):Promise<void> {
    await this.guard();
    const input:CaptureInput={mapping:this.mapping,channel:'navigate',index:0,evidenceId:randomUUID(),navigationUrl:url};
    await Promise.all([this.page.waitForNavigation({waitUntil:'domcontentloaded'}),this.page.evaluate(captureObserved,input)]);
    await this.guard();
  }
  async comments(index: number, allCommentAuthors=false, offset=0): Promise<ObservationBatch> {
    const work = this.mapping.works[index]; requireSafe(work,'OBSERVATION_WORK_REQUIRED');
    if(allCommentAuthors){if(offset===0||this.page.url().split('?')[0]!==work.url)await this.navigate(work.url);}
    else await this.page.goto(work.url,{waitUntil:'domcontentloaded'});
    await this.guard();
    if (!await this.page.evaluate(selector=>Array.from(document.querySelectorAll(selector)).some(n=>n.getClientRects().length),this.mapping.selectors.commentList))
      await this.page.locator(this.mapping.selectors.commentEntry).click();
    await this.page.waitForFunction(selector=>Array.from(document.querySelectorAll(selector)).filter(n=>n.getClientRects().length).length===1,
      this.mapping.selectors.commentList);
    try {
      await this.page.waitForFunction(({rows,empty})=>{
        const visible={check(node:Element):boolean{const r=node.getBoundingClientRect(),style=getComputedStyle(node);
          return r.width>0&&r.height>0&&style.display!=='none'&&style.visibility!=='hidden';}};
        return Array.from(document.querySelectorAll(rows)).some(visible.check)||
          Boolean(empty&&Array.from(document.querySelectorAll(empty)).some(visible.check));
      },{rows:this.mapping.selectors.commentRows,empty:this.mapping.selectors.commentEmpty},{timeout:15000});
    }catch{requireSafe(false,'OBSERVATION_COMMENTS_NOT_READY');}
    if(allCommentAuthors&&offset>0) {
      const input:CaptureInput={mapping:this.mapping,channel:'commentScroll',index,evidenceId:randomUUID(),commentOffset:offset};
      await this.page.evaluate(captureObserved,input);
    }
    const batch=await this.ready('comments',index,{allCommentAuthors});
    if(allCommentAuthors) {
      const input:CaptureInput={mapping:this.mapping,channel:'commentScroll',index,evidenceId:randomUUID()};
      const next=await this.page.evaluate(captureObserved,input);if(next.scroll)batch.scroll=next.scroll;
    }
    return batch;
  }
}
