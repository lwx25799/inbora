import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { ObservationMapping } from '../config/site-mapping.js';
import { eventSchema, requireSafe, type InboundEvent } from '../core/contracts.js';

interface CaptureInput { mapping: ObservationMapping; channel: 'identity' | 'dm' | 'comments' | 'row'; index: number;
  evidenceId: string; rowIndex?: number; select?: boolean }
export interface ObservationBatch { events: InboundEvent[]; evidenceId: string; unsupported: number; loaded: number }

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
      const r = element.getBoundingClientRect(), style = getComputedStyle(element);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    },
    one(root: Document | Element, selector: string): Element {
      const found = root.querySelectorAll(selector);
      dom.check(found.length > 0,'OBSERVATION_DOM_NOT_READY');
      dom.check(found.length === 1,'OBSERVATION_DOM_NOT_UNIQUE');
      dom.check(dom.visible(found[0]!),'OBSERVATION_DOM_NOT_READY'); return found[0]!;
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
    rowIdentity(row: Element, peer: ObservationMapping['peers'][number]): void {
      dom.check(row.isConnected && dom.visible(row),'OBSERVATION_ROW_UNAVAILABLE');
      dom.check(dom.one(row,s.conversationTitle).textContent?.trim()===peer.title,'OBSERVATION_ROW_CHANGED');
      const conversation=dom.data(dom.fiberProps(row,s.conversationFiberDepth),'conversation');
      dom.check(dom.conversationId(conversation)===peer.conversationId &&
        dom.data(conversation,'_toParticipantSecUserId')===peer.secUid,'OBSERVATION_ROW_IDENTITY_CONFLICT');
    },
    time(value: unknown, seconds: boolean): string | null {
      let time = NaN;
      if (seconds && typeof value === 'number' && Number.isFinite(value)) time = value * 1000;
      else if (!seconds) { try { time = Date.prototype.getTime.call(value); } catch { /* no date evidence */ } }
      return Number.isFinite(time) && time >= Date.UTC(2000,0,1) && time <= Date.now() ? new Date(time).toISOString() : null;
    },
  };
  dom.check(location.origin === m.origin && !/验证码|安全验证/.test(document.title), 'OBSERVATION_PAGE_BLOCKED');
  const avatar = dom.one(document,s.selfAvatar), own = dom.fiberProps(avatar,s.selfFiberDepth);
  dom.check(dom.data(own,'uid') === m.self.uid && dom.data(own,'secUid') === m.self.secUid,'OBSERVATION_ACCOUNT_CHANGED');
  const events: InboundEvent[] = []; let unsupported = 0, loaded = 0;
  if (channel === 'identity') return { events,evidenceId,unsupported,loaded };
  if(channel==='row') {
    const peer=m.peers[index], rows=document.querySelectorAll(s.conversationRows);
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
    const peer = m.peers[index]; dom.check(peer,'OBSERVATION_PEER_REQUIRED');
    const chat = dom.one(document,s.chat), header = dom.one(chat,s.chatHeader);
    const conversation = dom.data(dom.childProps(header),'conversation');
    const id = dom.conversationId(conversation);
    dom.check(id === peer!.conversationId && dom.data(conversation,'_toParticipantSecUserId') === peer!.secUid &&
      dom.one(chat,s.chatTitle).textContent?.trim() === peer!.title,'OBSERVATION_CONVERSATION_CHANGED');
    const rows = Array.from(chat.querySelectorAll(s.messages)).filter(dom.visible); loaded = rows.length;
    dom.check(rows.length <= 100,'OBSERVATION_WINDOW_TOO_LARGE');
    for (const row of rows) {
      const message = dom.data(dom.childProps(row),'message');
      dom.check(dom.data(message,'conversationId') === id,'OBSERVATION_MESSAGE_CONVERSATION_CONFLICT');
      const sender = dom.data(message,'sender'), box = row.closest(s.messageBox);
      dom.check(box && (sender === m.self.uid || sender === peer!.uid),'OBSERVATION_SENDER_UNVERIFIED');
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
    const list=dom.one(document,s.commentList),rows = Array.from(list.querySelectorAll(s.commentRows)); loaded = rows.length;
    dom.check(rows.length <= 100,'OBSERVATION_WINDOW_TOO_LARGE');
    const visibleRoots=rows.filter(row=>dom.visible(row)&&!row.parentElement?.closest(s.commentRows));
    const empty=s.commentEmpty?Array.from(list.querySelectorAll(s.commentEmpty)).filter(dom.visible):[];
    dom.check(visibleRoots.length>0||empty.length===1,'OBSERVATION_DOM_NOT_READY');
    for (const row of rows) {
      if (!dom.visible(row) || row.parentElement?.closest(s.commentRows)) continue;
      const authors = Array.from(row.querySelectorAll(s.commentAuthor));
      const profiles = authors.map(a => a.getAttribute('href')).filter(Boolean).map(href => new URL(href!,location.origin));
      const peer = m.peers.find(p => profiles.some(url => url.origin === m.origin && url.pathname === `/user/${p.secUid}`));
      if (!peer) continue;
      const props = dom.fiberProps(row,s.commentFiberDepth), comment = dom.data(props,'commentInfo');
      const author = dom.data(comment,'user'), aweme = dom.data(props,'awemeInfo'), self = dom.data(props,'userInfo');
      dom.check(dom.data(aweme,'awemeId') === work!.id && dom.data(self,'uid') === m.self.uid,'OBSERVATION_COMMENT_WORK_CONFLICT');
      dom.check(dom.data(author,'uid') === peer.uid && dom.data(author,'secUid') === peer.secUid,'OBSERVATION_COMMENT_AUTHOR_CONFLICT');
      const id = dom.id(dom.data(comment,'cid')), tooltip = dom.one(row,s.commentTooltip);
      dom.check(id && tooltip.id === `tooltip_${id}`,'OBSERVATION_COMMENT_ID_CONFLICT');
      const text = dom.one(row,s.commentText).textContent ?? '';
      dom.check(text.length > 0 && text === dom.data(comment,'text'),'OBSERVATION_COMMENT_TEXT_CONFLICT');
      events.push({ accountId:'account_001',channel:'COMMENT_NOTIFICATION',platformEventId:id,actorId:peer.uid,
        actorName:peer.title,text,occurredAt:dom.time(dom.data(comment,'createTime'),true),videoId:work!.id,commentId:id,
        conversationId:null,direction:'INCOMING',kind:'COMMENT',evidenceId,discovery:'ALLOWED_WORK' });
    }
  }
  dom.check(new Set(events.map(e=>e.platformEventId).filter(Boolean)).size === events.filter(e=>e.platformEventId).length,
    'OBSERVATION_MESSAGE_ID_COLLISION');
  return { events,evidenceId,unsupported,loaded };
}

/** AccountActor owns the entire call, including opening and switching the permitted chat. */
export class ObservedReader {
  constructor(readonly page: Page, readonly mapping: ObservationMapping) {}
  private async capture(channel: CaptureInput['channel'], index: number, selection: {rowIndex?:number;select?:boolean} = {}): Promise<ObservationBatch> {
    try {
      const result = await this.page.evaluate(captureObserved,{mapping:this.mapping,channel,index,evidenceId:randomUUID(),...selection});
      return {...result,events:result.events.map(e=>eventSchema.parse(e))};
    } catch(error) {
      const code=error instanceof Error ? error.message.match(/(?:OBSERVATION|RENDERED)_[A-Z_]+/)?.[0] : null;
      if(code) requireSafe(false,code);throw error;
    }
  }
  private async ready(channel: CaptureInput['channel'],index: number): Promise<ObservationBatch> {
    const deadline=Date.now()+5000;
    for(;;)try{return await this.capture(channel,index);}catch(error){
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
  async dm(index: number): Promise<ObservationBatch> {
    const s = this.mapping.selectors, peer = this.mapping.peers[index]; requireSafe(peer,'OBSERVATION_PEER_REQUIRED');
    await this.guard();
    if (!await this.page.locator(s.dmPanel).isVisible()) await this.page.locator(s.dmEntry).click();
    await this.page.locator(s.dmPanel).waitFor({state:'visible'});
    const chat = this.page.locator(s.chat);
    if (await chat.isVisible()) {
      try { return await this.ready('dm',index); } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('OBSERVATION_CONVERSATION_CHANGED')) throw error;
        // A different visible chat must close normally before selecting another permitted row.
        await this.page.locator(s.chatBack).click(); await chat.waitFor({state:'hidden'});
      }
    }
    await this.page.waitForFunction(selector=>Array.from(document.querySelectorAll(selector))
      .some(row=>{const r=row.getBoundingClientRect(),style=getComputedStyle(row);
        return r.width>0&&r.height>0&&style.display!=='none'&&style.visibility!=='hidden';}),s.conversationRows);
    const matches: number[] = [];let rowIndex=0;
    for (const row of await this.page.locator(s.conversationRows).all()) {
      if (await row.isVisible() && await row.locator(s.conversationTitle).count() === 1 &&
        (await row.locator(s.conversationTitle).textContent())?.trim() === peer.title) {
        await this.capture('row',index,{rowIndex});matches.push(rowIndex);
      }
      rowIndex++;
    }
    requireSafe(matches.length === 1,'OBSERVATION_CONVERSATION_NOT_UNIQUE');
    await this.capture('row',index,{rowIndex:matches[0]!,select:true});
    await chat.waitFor({state:'visible'}); return this.ready('dm',index);
  }
  async comments(index: number): Promise<ObservationBatch> {
    const work = this.mapping.works[index]; requireSafe(work,'OBSERVATION_WORK_REQUIRED');
    await this.page.goto(work.url,{waitUntil:'domcontentloaded'});
    await this.guard();
    if (!await this.page.locator(this.mapping.selectors.commentList).isVisible())
      await this.page.locator(this.mapping.selectors.commentEntry).click();
    await this.page.locator(this.mapping.selectors.commentList).waitFor({state:'visible'});
    try {
      await this.page.waitForFunction(({rows,empty})=>{
        const visible={check(node:Element):boolean{const r=node.getBoundingClientRect(),style=getComputedStyle(node);
          return r.width>0&&r.height>0&&style.display!=='none'&&style.visibility!=='hidden';}};
        return Array.from(document.querySelectorAll(rows)).some(visible.check)||
          Boolean(empty&&Array.from(document.querySelectorAll(empty)).some(visible.check));
      },{rows:this.mapping.selectors.commentRows,empty:this.mapping.selectors.commentEmpty},{timeout:15000});
    }catch{requireSafe(false,'OBSERVATION_COMMENTS_NOT_READY');}
    return this.ready('comments',index);
  }
}
