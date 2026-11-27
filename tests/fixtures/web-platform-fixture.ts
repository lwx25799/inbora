import { once } from 'node:events';
import { createServer } from 'node:http';
import type { WebBrowserPlatformId } from '../../src/contracts/account.js';

export async function startWebFixtureServer(config: {
  platform: WebBrowserPlatformId;
  selfId: string;
  hideReadback?: boolean;
}) {
  let posts = 0;
  let sentReplies: { channel: string; convId?: string; parentId?: string; id: string; text: string; sentAt: string }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/send') {
      posts++;
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { channel?: string; convId?: string; parentId?: string; text?: string };
        setTimeout(() => {
          const record = {
            channel: parsed.channel ?? 'dm',
            ...(parsed.convId ? { convId: parsed.convId } : {}),
            ...(parsed.parentId ? { parentId: parsed.parentId } : {}),
            id: `out-${posts}`,
            text: parsed.text ?? '',
            sentAt: new Date().toISOString(),
          };
          if (!config.hideReadback) sentReplies.push(record);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, ...record }));
        }, 10);
      });
      return;
    }
    const dmInitial = {
      'conv-99': sentReplies.filter(r => r.channel === 'dm' && r.convId === 'conv-99'),
      'conv-100': sentReplies.filter(r => r.channel === 'dm' && r.convId === 'conv-100'),
    };
    const commentInitial = sentReplies.filter(r => r.channel === 'comment' && r.parentId === 'cmt-in-1');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html>
  <head><title>${config.platform} fixture</title></head>
  <body>
    <div id="self-id" data-uid="${config.selfId}">${config.selfId}</div>
    <div id="dm-list">
      <div class="dm-conv-item" data-conversation-id="conv-99" data-peer-id="peer-99">
        <button class="dm-conv-open" type="button">会话99</button>
      </div>
      <div class="dm-conv-item" data-conversation-id="conv-100" data-peer-id="peer-200">
        <button class="dm-conv-open" type="button">会话100</button>
      </div>
    </div>
    <div id="dm-pane" data-conversation-id="conv-99">
      <div id="dm-messages"></div>
      <div id="dm-outgoing"></div>
      <textarea id="dm-composer"></textarea>
      <button id="dm-send" type="button">发送</button>
    </div>
    <div id="comment-list" data-video-id="vid-300">
      <div class="comment-row" data-comment-id="cmt-other" data-author-id="peer-999" data-video-id="vid-300">
        <span class="comment-text">无关评论</span>
        <span class="comment-time" data-occurred-at="2026-11-27T00:30:00.000Z">2026-11-27T00:30:00.000Z</span>
        <button class="comment-open-reply" type="button">展开回复</button>
        <div class="comment-outgoing"></div>
        <div class="comment-editor-box" style="display:none">
          <textarea class="comment-composer"></textarea>
          <button class="comment-send" type="button">回复</button>
        </div>
      </div>
      <div class="comment-row" data-comment-id="cmt-in-1" data-author-id="peer-301" data-video-id="vid-300">
        <span class="comment-text">这个怎么买？</span>
        <span class="comment-time" data-occurred-at="2026-11-27T01:00:00.000Z">2026-11-27T01:00:00.000Z</span>
        <button class="comment-open-reply" type="button">展开回复</button>
        <div class="comment-reply from-me" data-comment-id="decoy-wrong-parent" data-parent-id="cmt-other" data-author-id="${config.selfId}" data-delivery-status="confirmed">
          <span class="reply-text">错父评论回复</span>
          <span class="reply-time" data-occurred-at="2099-01-01T00:00:00.000Z">2099-01-01T00:00:00.000Z</span>
        </div>
        <div class="comment-reply from-me" data-comment-id="decoy-no-parent" data-author-id="${config.selfId}" data-delivery-status="confirmed">
          <span class="reply-text">无父ID散落回复</span>
          <span class="reply-time" data-occurred-at="2099-01-01T00:00:00.000Z">2099-01-01T00:00:00.000Z</span>
        </div>
        <div class="comment-outgoing"></div>
        <div class="comment-editor-box" style="display:none">
          <textarea class="comment-composer"></textarea>
          <button class="comment-send" type="button">回复</button>
        </div>
      </div>
    </div>
    <script>
      const dmThreads = {
        'conv-99': '<div class="dm-msg" data-message-id="dm-other" data-sender-id="peer-99"><span class="dm-text">别的对话</span><span class="dm-time" data-occurred-at="2026-11-27T00:30:00.000Z">2026-11-27T00:30:00.000Z</span></div>',
        'conv-100': '<div class="dm-msg" data-message-id="dm-in-1" data-sender-id="peer-200"><span class="dm-text">你好，请问发货吗？</span><span class="dm-time" data-occurred-at="2026-11-27T01:00:00.000Z">2026-11-27T01:00:00.000Z</span></div>',
      };
      const dmOutgoingByConv = ${JSON.stringify(dmInitial)};
      const commentInitial = ${JSON.stringify(commentInitial)};
      const dmPane = document.getElementById('dm-pane');
      const dmMessages = document.getElementById('dm-messages');
      const dmOutgoing = document.getElementById('dm-outgoing');
      function appendReply(container, item, attrName, senderAttr, cls) {
        const div = document.createElement('div');
        div.className = cls + ' from-me';
        div.setAttribute(attrName, item.id);
        div.setAttribute(senderAttr, ${JSON.stringify(config.selfId)});
        if (item.parentId) div.setAttribute('data-parent-id', item.parentId);
        div.setAttribute('data-delivery-status', 'confirmed');
        div.innerHTML = '<span class="reply-text"></span><span class="reply-time" data-occurred-at="' + item.sentAt + '">' + item.sentAt + '</span>';
        div.querySelector('.reply-text').textContent = item.text;
        container.appendChild(div);
      }
      function renderDmConv(convId) {
        dmPane.setAttribute('data-conversation-id', convId);
        dmMessages.innerHTML = dmThreads[convId] || '';
        dmOutgoing.innerHTML = '';
        for (const item of dmOutgoingByConv[convId] || []) {
          appendReply(dmOutgoing, item, 'data-message-id', 'data-sender-id', 'dm-msg');
        }
      }
      renderDmConv('conv-99');
      for (const itemEl of document.querySelectorAll('.dm-conv-item')) {
        itemEl.querySelector('.dm-conv-open').addEventListener('click', () => {
          renderDmConv(itemEl.getAttribute('data-conversation-id'));
        });
      }
      document.getElementById('dm-send').addEventListener('click', async () => {
        const convId = dmPane.getAttribute('data-conversation-id');
        const text = document.getElementById('dm-composer').value;
        const res = await fetch('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'dm', convId, text }) });
        const data = await res.json();
        document.getElementById('dm-composer').value = '';
        if (!${JSON.stringify(Boolean(config.hideReadback))}) {
          dmOutgoingByConv[convId].push(data);
          appendReply(dmOutgoing, data, 'data-message-id', 'data-sender-id', 'dm-msg');
        }
      });
      for (const cmtRow of document.querySelectorAll('.comment-row')) {
        const commentId = cmtRow.getAttribute('data-comment-id');
        const editorBox = cmtRow.querySelector('.comment-editor-box');
        if (commentId === 'cmt-in-1') {
          for (const item of commentInitial) {
            appendReply(cmtRow.querySelector('.comment-outgoing'), item, 'data-comment-id', 'data-author-id', 'comment-reply');
          }
        }
        cmtRow.querySelector('.comment-open-reply').addEventListener('click', () => {
          editorBox.style.display = 'block';
        });
        cmtRow.querySelector('.comment-send').addEventListener('click', async () => {
          const text = cmtRow.querySelector('.comment-composer').value;
          const res = await fetch('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'comment', parentId: commentId, text }) });
          const data = await res.json();
          cmtRow.querySelector('.comment-composer').value = '';
          editorBox.style.display = 'none';
          if (!${JSON.stringify(Boolean(config.hideReadback))}) {
            appendReply(cmtRow.querySelector('.comment-outgoing'), data, 'data-comment-id', 'data-author-id', 'comment-reply');
          }
        });
      }
    </script>
  </body>
</html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Missing server address');
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    posts: () => posts,
    close: async () => {
      const closed = new Promise<void>(resolveClose => server.close(() => resolveClose()));
      server.closeAllConnections();
      await closed;
    },
  };
}

export function buildFixtureMappings(platform: WebBrowserPlatformId, origin: string, selfId: string) {
  const observation = {
    platform,
    environment: 'fixture' as const,
    origin,
    entryUrl: `${origin}/`,
    selfId,
    selectors: {
      selfId: '#self-id',
      selfIdAttribute: 'data-uid',
      dm: {
        pane: '#dm-pane',
        list: '#dm-list',
        conversationRows: '.dm-conv-item',
        conversationIdAttribute: 'data-conversation-id',
        peerIdAttribute: 'data-peer-id',
        selectAction: '.dm-conv-open',
        activeConversationIdAttribute: 'data-conversation-id',
        messages: '.dm-msg',
        messageIdAttribute: 'data-message-id',
        senderIdAttribute: 'data-sender-id',
        messageText: '.dm-text',
        messageTime: '.dm-time',
        messageTimeAttribute: 'data-occurred-at',
        fromMeClass: 'from-me',
      },
      comment: {
        list: '#comment-list',
        rows: '.comment-row',
        rowIdAttribute: 'data-comment-id',
        authorIdAttribute: 'data-author-id',
        videoIdAttribute: 'data-video-id',
        text: '.comment-text',
        time: '.comment-time',
        timeAttribute: 'data-occurred-at',
        fromMeClass: 'from-me',
      },
    },
  };
  const reply = {
    platform,
    environment: 'fixture' as const,
    origin,
    entryUrl: `${origin}/`,
    selfId,
    selectors: {
      selfId: '#self-id',
      selfIdAttribute: 'data-uid',
      dm: {
        ...observation.selectors.dm,
        composer: '#dm-composer',
        send: '#dm-send',
        outgoingRows: '#dm-outgoing .dm-msg.from-me',
        proofText: '.reply-text',
        proofTime: '.reply-time',
        proofTimeAttribute: 'data-occurred-at',
      },
      comment: {
        ...observation.selectors.comment,
        openReply: '.comment-open-reply',
        directRepliesSelector: '.comment-outgoing',
        composer: '.comment-composer',
        send: '.comment-send',
        outgoingRows: '.comment-reply.from-me',
        proofText: '.reply-text',
        proofTime: '.reply-time',
        proofTimeAttribute: 'data-occurred-at',
      },
    },
  };
  return { observation, reply };
}
