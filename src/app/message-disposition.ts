import {randomUUID} from 'node:crypto';
import {eventBinding,type StoredEvent} from '../core/contracts.js';
import {decodeEventRow,type EventRow,type EventStore} from '../storage/store.js';
import {MessageShareStore} from '../storage/message-shares.js';
import {MessagePreviewStore} from '../storage/message-previews.js';

function incomingMedia(event:StoredEvent,ownId:string):boolean {
  const e=event.payload;
  return e.accountId==='account_001'&&e.channel==='DIRECT_MESSAGE'&&e.kind==='DM'&&e.direction==='INCOMING'&&
    !!e.actorId&&e.actorId!==ownId&&!!e.conversationId&&/^[1-9]\d{0,63}$/u.test(e.platformEventId??'')&&
    !!e.occurredAt&&Number.isFinite(Date.parse(e.occurredAt))&&e.observationIssue==='DM_CONTENT_UNVERIFIED'&&
    eventBinding(e)===event.binding;
}

/** Message kind outlives rebuildable previews. It is not a delivery receipt or permission to send. */
export function readNoReplyEventIds(store:EventStore):Set<string> {
  const own=store.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id:string}|undefined;
  if(!own)return new Set();
  const rows=store.db.prepare(`SELECT DISTINCT e.id,e.payload,e.binding,e.status FROM inbound_events e JOIN audit_events a ON a.entity_id=e.id
    WHERE a.event_type='INBOUND_DISPLAY_CLASSIFIED' AND json_extract(a.detail_redacted,'$.eventType')='DOUYIN_WORK_SHARE'
      AND json_extract(a.detail_redacted,'$.binding')=e.binding`).all() as EventRow[];
  return new Set(rows.map(decodeEventRow).filter(event=>incomingMedia(event,own.own_id)).map(event=>event.id));
}

/** Backfill the bounded recent inbox at startup; refresh the current conversation after normal collection. */
export function classifyStoredShares(store:EventStore,root:string,conversationId?:string):number {
  const own=store.db.prepare("SELECT own_id FROM accounts WHERE id='account_001'").get() as {own_id:string}|undefined;
  if(!own)return 0;
  const rows=store.db.prepare(`SELECT e.id,e.payload,e.binding,e.status FROM inbound_events e
    WHERE e.account_id='account_001' AND e.channel='DIRECT_MESSAGE' AND e.status<>'BASELINE'
      AND json_extract(e.payload,'$.observationIssue')='DM_CONTENT_UNVERIFIED'
      ${conversationId===undefined?'':"AND json_extract(e.payload,'$.conversationId')=?"}
      AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.entity_id=e.id AND a.event_type='INBOUND_DISPLAY_CLASSIFIED'
        AND json_extract(a.detail_redacted,'$.eventType')='DOUYIN_WORK_SHARE' AND json_extract(a.detail_redacted,'$.binding')=e.binding)
    ORDER BY e.rowid DESC LIMIT 1000`).all(...(conversationId===undefined?[]:[conversationId])) as EventRow[];
  const shares=new MessageShareStore(root),previews=new MessagePreviewStore(root);
  const classified=rows.map(decodeEventRow).filter(event=>incomingMedia(event,own.own_id)&&
    (!!shares.read(event.payload,own.own_id)||previews.list(event.payload,own.own_id)
      .some(item=>item.state==='UNAVAILABLE'&&item.reason==='MESSAGE_PREVIEW_SHARE_LINK_UNVERIFIED')));
  return store.db.transaction(()=>{
    const insert=store.db.prepare(`INSERT INTO audit_events(id,time,event_type,entity_id,detail_redacted)
      SELECT ?,?,'INBOUND_DISPLAY_CLASSIFIED',?,? WHERE NOT EXISTS(SELECT 1 FROM audit_events
        WHERE entity_id=? AND event_type='INBOUND_DISPLAY_CLASSIFIED' AND json_extract(detail_redacted,'$.binding')=?)`);
    let count=0;
    for(const event of classified)count+=insert.run(randomUUID(),new Date().toISOString(),event.id,
      JSON.stringify({binding:event.binding,eventType:'DOUYIN_WORK_SHARE'}),event.id,event.binding).changes;
    return count;
  }).immediate();
}
