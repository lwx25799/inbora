import type {EventStore} from '../storage/store.js';
import {randomUUID} from 'node:crypto';

/** Reading is local display state. It never changes task, draft, intent or receipt state. */
export function inboxReadBoundary(store:EventStore):number {
  const row=store.db.prepare(`SELECT max(CAST(json_extract(detail_redacted,'$.through') AS INTEGER)) AS through
    FROM audit_events WHERE event_type='INBOX_MARKED_READ' AND entity_id='account_001'`).get() as {through:number|null};
  return row.through??0;
}

/** Assistant marks are exact observed rows; they cannot create a channel-wide future watermark. */
export function scopedReadEventIds(store:EventStore,boundary=inboxReadBoundary(store)):Set<string> {
  const rows=store.db.prepare(`SELECT e.id FROM audit_events a,
    json_each(a.detail_redacted,'$.eventIds') j JOIN inbound_events e ON e.id=j.value
    WHERE a.event_type='INBOX_SCOPE_MARKED_READ' AND a.entity_id='account_001'
    AND j.type='text' AND e.account_id='account_001' AND e.rowid>?`).all(boundary) as {id:string}[];
  return new Set(rows.map(row=>row.id));
}

export function markInboxRead(store:EventStore,eventIds?:readonly string[]):{marked:number} {
  return store.db.transaction(()=>{
    const previous=inboxReadBoundary(store);
    const scoped=scopedReadEventIds(store,previous);
    if(eventIds!==undefined){
      const ids=[...new Set(eventIds)],unread:string[]=[];
      for(let offset=0;offset<ids.length;offset+=200){
        const chunk=ids.slice(offset,offset+200);
        const rows=store.db.prepare(`SELECT id FROM inbound_events WHERE account_id='account_001'
          AND status<>'BASELINE' AND rowid>? AND id IN (${chunk.map(()=>'?').join(',')})`).all(previous,...chunk) as {id:string}[];
        unread.push(...rows.map(row=>row.id).filter(id=>!scoped.has(id)));
      }
      for(let offset=0;offset<unread.length;offset+=200){
        store.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),
          'INBOX_SCOPE_MARKED_READ','account_001',JSON.stringify({eventIds:unread.slice(offset,offset+200)}));
      }
      return {marked:unread.length};
    }
    const {through}=store.db.prepare("SELECT COALESCE(max(rowid),0) AS through FROM inbound_events WHERE account_id='account_001'").get() as {through:number};
    const rows=store.db.prepare("SELECT id FROM inbound_events WHERE account_id='account_001' AND status<>'BASELINE' AND rowid>?")
      .all(previous) as {id:string}[];
    const marked=rows.filter(row=>!scoped.has(row.id)).length;
    if(through>previous)store.audit('INBOX_MARKED_READ','account_001',{through,marked});
    return {marked};
  }).immediate();
}
