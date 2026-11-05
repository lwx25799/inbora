import type { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import type { ObservationMapping, DmReplyMapping } from '../../src/config/site-mapping.js';

// Synthetic rendered component contract; no real identities or private source data.
export function observedMapping(origin: string): ObservationMapping {
  return {version:1,purpose:'observation',environment:'fixture',origin,entryUrl:origin,
    observedAt:'2026-11-05T00:00:00Z',evidenceRef:'synthetic-rendered-only',self:{uid:'100',secUid:'self-sec'},
    peers:[{uid:'200',secUid:'peer-sec',conversationId:'conv-a',title:'Fixture peer'}],works:[{id:'10',url:origin+'/video/10'}],
    selectors:{selfAvatar:'#self',selfFiberDepth:1,dmEntry:'#dm-open',dmPanel:'#dm-panel',conversationRows:'.conversation',
      conversationTitle:'.title',conversationFiberDepth:1,conversationSelectEvent:'click',chat:'#chat',chatHeader:'#header',chatTitle:'#chat-title',chatBack:'#back',
      messages:'.message',messageBox:'.box',fromMeClass:'from-me',messageText:'.text',commentList:'#comment-list',
      commentEntry:'#comment-open',commentRows:'.comment',commentText:'.body',commentAuthor:'.author',
      commentTooltip:'.tooltip',commentEmpty:'#empty-comments',commentFiberDepth:1}};
}
export async function mountObserved(owner: BrowserProfileOwner, origin: string): Promise<void> {
  await owner.dm.goto(origin);
  await owner.dm.setContent(`<a id="self">Self</a><button id="dm-open">Open</button><section id="dm-panel">
    <div class="conversation"><span class="title">Fixture peer</span></div><div id="chat">
    <div id="header"><span id="chat-title">Fixture peer</span></div><button id="back">Back</button>
    <div class="box"><div class="message"><span class="text">controlled-1</span></div></div>
    <div class="box"><div class="message"><span class="text">controlled-2</span></div></div>
    <div class="box"><div class="message"><span class="text">controlled-3</span></div></div>
    <div class="box"><div class="direction from-me"><div class="message"><span class="text">owner text</span></div></div></div>
    <div class="box"><div class="message"><img alt="fixture emoji"></div></div></div></section>`);
  await owner.dm.evaluate(() => {
    const self = document.querySelector('#self')!;
    Object.defineProperty(self,'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});
    Object.defineProperty(document.querySelector('#header')!,'__reactProps$fixture',
      {value:{children:{props:{conversation:{id:'conv-a',_toParticipantSecUserId:'peer-sec'}}}}});
    Object.defineProperty(document.querySelector('.conversation')!,'__reactFiber$fixture',
      {value:{return:{memoizedProps:{conversation:{id:'conv-a',_toParticipantSecUserId:'peer-sec'}}}}});
    for (const [index,row] of [...document.querySelectorAll('.message')].entries())
      Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{
        serverId:String(index+1),conversationId:'conv-a',sender:index===3?'100':'200',
        createdAt:new Date('2026-11-05T00:00:00Z'),_parsedContent:{text:row.textContent}}}}}});
  });
}

export function dmReplyMapping(origin:string):DmReplyMapping {
  return{version:1,purpose:'dm-reply',observation:observedMapping(origin),observedAt:'2026-11-05T00:00:00Z',
    evidenceRef:'synthetic-native-dm-reply',blockers:'[role="dialog"]',composer:'#native-editor',send:'#native-send',
    pending:'.pending',failed:'.failed',composerScope:'#native-controls',composerFiberDepth:1,
    latestIndexAncestor:'[data-index]',submission:'svg-click-event',confirmedServerStatus:0,textMessageType:7};
}
/** Synthetic native component metadata and actual SVG event bubbling; no real user values. */
export async function mountDmReply(owner:BrowserProfileOwner,origin:string):Promise<void>{
  await mountObserved(owner,origin);
  await owner.dm.evaluate(()=>{
    for(const [index,row]of Array.from(document.querySelectorAll('.message')).entries()){
      row.closest('.box')!.setAttribute('data-index',String(index));
      const message=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      message.serverStatus=0;message.type=7;
    }
    const chat=document.querySelector('#chat')!;
    const controls=document.createElement('div');controls.id='native-controls';
    controls.innerHTML='<div id="native-editor" contenteditable="true" style="white-space:pre-wrap">\u200B</div><svg id="native-send" width="30" height="30"><rect width="30" height="30"/></svg>';
    Object.defineProperty(controls,'__reactFiber$fixture',{value:{return:{memoizedProps:{curConversation:{id:'conv-a',_toParticipantSecUserId:'peer-sec'}}}}});
    chat.append(controls);
    const state=window as unknown as {nativeClicks:number;nativePending:boolean;nativeWrongReceipt:boolean;nativeOldReceipt:boolean;nativeNoReceipt:boolean;nativeEditorModel:string};
    state.nativeClicks=0;state.nativePending=false;state.nativeWrongReceipt=false;state.nativeOldReceipt=false;state.nativeNoReceipt=false;
    state.nativeEditorModel='';
    // Minimal synthetic editor model uses actual browser edit events, independently of the adapter's DOM reader.
    document.querySelector('#native-editor')!.addEventListener('input',event=>{
      const input=event as InputEvent;
      if(input.inputType==='insertText')state.nativeEditorModel+=input.data??'\n';
      else if(!document.querySelector('#native-editor')!.textContent)state.nativeEditorModel='';
    });
    document.querySelector('#native-send')!.addEventListener('click',()=>{
      state.nativeClicks++;
      if(state.nativeNoReceipt)return;
      for(const box of chat.querySelectorAll('[data-index]'))box.setAttribute('data-index',String(Number(box.getAttribute('data-index'))+1));
      const editor=document.querySelector('#native-editor') as HTMLElement,text=state.nativeEditorModel,box=document.createElement('div');
      box.className='box from-me';box.setAttribute('data-index','0');
      const row=document.createElement('div');row.className='message';const body=document.createElement('span');
      body.className='text';body.textContent=text;row.append(body);box.append(row);
      if(state.nativePending){const pending=document.createElement('span');pending.className='pending';pending.textContent='Pending';box.append(pending);}
      const createdAt=state.nativeOldReceipt?new Date('2020-01-01T00:00:00Z'):new Date(Date.now()+3);
      Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:String(800+state.nativeClicks),
        conversationId:state.nativeWrongReceipt?'outside':'conv-a',sender:'100',createdAt,
        serverStatus:0,type:7,_parsedContent:{text}}}}}});
      chat.append(box);editor.textContent='';
    });
  });
}
