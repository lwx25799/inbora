import type { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import type { ObservationMapping } from '../../src/config/site-mapping.js';

// Synthetic rendered component contract; no real identities or private source data.
export function observedMapping(origin: string): ObservationMapping {
  return {version:1,purpose:'observation',environment:'fixture',origin,entryUrl:origin,
    observedAt:'2026-11-05T00:00:00Z',evidenceRef:'synthetic-rendered-only',self:{uid:'100',secUid:'self-sec'},
    peers:[{uid:'200',secUid:'peer-sec',conversationId:'conv-a',title:'Fixture peer'}],works:[{id:'10',url:origin+'/video/10'}],
    selectors:{selfAvatar:'#self',selfFiberDepth:1,dmEntry:'#dm-open',dmPanel:'#dm-panel',conversationRows:'.conversation',
      conversationTitle:'.title',conversationFiberDepth:1,conversationSelectEvent:'click',chat:'#chat',chatHeader:'#header',chatTitle:'#chat-title',chatBack:'#back',
      messages:'.message',messageBox:'.box',fromMeClass:'from-me',messageText:'.text',commentList:'#comment-list',
      commentEntry:'#comment-open',commentRows:'.comment',commentText:'.body',commentAuthor:'.author',
      commentTooltip:'.tooltip',commentFiberDepth:1}};
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
