import { createServer } from 'node:http';
import type { SiteMapping } from '../../src/config/site-mapping.js';

// Entirely synthetic. These attributes are a fixture contract, never Douyin selectors.
export const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>inbora synthetic site</title><style>section{min-height:24px;min-width:100px}</style></head>
<body><div id="account" data-id="own-1">Fixture owner</div><div id="login" hidden>Login</div>
<div id="challenge" hidden>Challenge</div><div id="stop" hidden>Stop</div>
<button id="notification-entry">Notifications</button><button id="dm-entry">Messages</button>
<section id="notifications" hidden></section><section id="comment-target" hidden></section>
<section id="dm-list" hidden><div data-conversation="conversation-1" data-peer="peer-1" data-active="true"><button>Select first</button></div>
<div data-conversation="conversation-2" data-peer="peer-2" data-active="false"><button>Select second</button></div></section>
<section id="dm-pane" data-active="conversation-1" data-peer="peer-1" hidden><div id="messages"></div>
<textarea id="dm-composer" data-target="dm:conversation-1"></textarea><button id="dm-send">Send DM</button><div id="dm-outgoing"></div></section>
<script>
let seq=0;window.clicks=0;window.pending=false;window.suppress=false;window.switchDelay=0;window.freezeSwitch=false;
const messages={'conversation-1':[],'conversation-2':[]};
function eventRow(e,cls){let r=document.createElement('div');r.className=cls;
for(const [k,v] of Object.entries(e))if(v!==null)r.setAttribute('data-'+k,v);
let text=document.createElement('span');text.className='body';text.textContent=e.text;r.append(text);return r;}
window.addNotification=(e)=>{let r=eventRow(e,'notification');let b=document.createElement('button');b.className='jump';b.textContent='Open original';
b.onclick=()=>{document.querySelector('#comment-target').hidden=false;document.querySelector('#comment-target').replaceChildren();
let root=eventRow(e,'comment');root.id='original-comment';let replies=document.createElement('div');replies.className='replies';root.append(replies);
let input=document.createElement('textarea');input.id='comment-composer';input.setAttribute('data-target','comment:'+e.video+':'+e.comment);root.append(input);
let send=document.createElement('button');send.id='comment-send';send.textContent='Reply';send.onclick=()=>deliver(root.querySelector('.replies'),input);root.append(send);
document.querySelector('#comment-target').append(root);};r.append(b);document.querySelector('#notifications').append(r);};
function proof(parent,input){let p=document.createElement('div');p.className='outgoing';p.setAttribute('data-id','out-'+(++seq));p.setAttribute('data-own','own-1');
p.setAttribute('data-target',input.getAttribute('data-target'));p.setAttribute('data-status',window.pending?'pending':'confirmed');p.setAttribute('data-sent-at',new Date().toISOString());p.textContent=input.value;parent.append(p);}
function deliver(parent,input){window.clicks++;if(!window.suppress)proof(parent,input);input.value='';}
window.addDm=(id,e)=>{messages[id].push(e);if(document.querySelector('#dm-pane').getAttribute('data-active')===id)render(id);};
function render(id){document.querySelector('#messages').replaceChildren(...messages[id].map(e=>eventRow(e,'message')));}
document.querySelector('#notification-entry').onclick=()=>document.querySelector('#notifications').hidden=false;
document.querySelector('#dm-entry').onclick=()=>{document.querySelector('#dm-list').hidden=false;document.querySelector('#dm-pane').hidden=false;};
for(let row of document.querySelectorAll('#dm-list>div'))row.querySelector('button').onclick=()=>{
if(window.freezeSwitch)return;let id=row.getAttribute('data-conversation');setTimeout(()=>{for(let item of document.querySelectorAll('#dm-list>div'))item.setAttribute('data-active',String(item===row));document.querySelector('#dm-pane').setAttribute('data-active',id);
document.querySelector('#dm-pane').setAttribute('data-peer',row.getAttribute('data-peer'));document.querySelector('#dm-composer').setAttribute('data-target','dm:'+id);
document.querySelector('#dm-outgoing').replaceChildren();render(id);},window.switchDelay);};
document.querySelector('#dm-send').onclick=()=>deliver(document.querySelector('#dm-outgoing'),document.querySelector('#dm-composer'));
</script></body></html>`;

const attr = (attribute: string) => ({ attribute });
const fields = {
  platformEventId: attr('data-event'), actorId: attr('data-actor'), actorName: attr('data-name'),
  text: { selector: '.body' }, occurredAt: attr('data-time'), videoId: attr('data-video'),
  commentId: attr('data-comment'), conversationId: attr('data-conversation'),
  direction: attr('data-direction'), kind: attr('data-kind'),
};
const proof = { id: attr('data-id'), ownId: attr('data-own'), targetKey: attr('data-target'), text: {}, pending: attr('data-status'), sentAt: attr('data-sent-at') };
export function mapping(origin: string): SiteMapping {
  return {
    version: 1, environment: 'fixture', origin, observedAt: '2026-11-04T00:00:00Z', evidenceRef: 'synthetic-only', ownId: 'own-1',
    guards: { loggedIn: '#account', loginRequired: '#login', challenge: '#challenge', stopped: '#stop', ownIdentity: { selector: '#account', attribute: 'data-id' } },
    notification: { entry: '#notification-entry', panel: '#notifications', rows: '.notification', fields, jump: '.jump' },
    dm: { entry: '#dm-entry', list: '#dm-list', rows: ':scope > div', activeRow: ':scope > div[data-active="true"]', conversationId: attr('data-conversation'), peerId: attr('data-peer'),
      select: 'button', pane: '#dm-pane', activeId: attr('data-active'), activePeerId: attr('data-peer'), messages: '.message', fields },
    targets: {
      COMMENT_NOTIFICATION: { roots: '.comment', fields, openReply: null, composer: '#comment-composer',
        composerTarget: attr('data-target'), send: '#comment-send', outgoingRows: '.outgoing', proof },
      DIRECT_MESSAGE: { roots: '.message', fields, openReply: null, composer: '#dm-composer',
        composerTarget: attr('data-target'), send: '#dm-send', outgoingRows: '.outgoing', proof },
    },
    directionValues: { incoming: 'INCOMING', outgoing: 'OUTGOING', system: 'SYSTEM' },
    kindValues: { comment: 'COMMENT', reply: 'REPLY', dm: 'DM', like: 'LIKE', follow: 'FOLLOW', system: 'SYSTEM' },
  };
}
export function rowData(channel: 'dm' | 'comment', overrides: Record<string, string> = {}): Record<string, string> {
  return { event: 'event-1', actor: 'peer-1', name: 'Fixture peer', text: 'hello', time: '2026-11-04T00:00:00Z',
    ...(channel === 'dm' ? { conversation: 'conversation-1' } : { video: 'video-1', comment: 'comment-1' }),
    direction: 'incoming', kind: channel, ...overrides };
}
export async function fixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('fixture not listening');
  return { origin: `http://127.0.0.1:${addr.port}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
