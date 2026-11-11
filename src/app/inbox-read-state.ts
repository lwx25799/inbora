import type {EventStore} from '../storage/store.js';

/** Reading is local display state. It never changes task, draft, intent or receipt state. */
export function inboxReadBoundary(store:EventStore):number {
  const row=store.db.prepare(`SELECT max(CAST(json_extract(detail_redacted,'$.through') AS INTEGER)) AS through
    FROM audit_events WHERE event_type='INBOX_MARKED_READ' AND entity_id='account_001'`).get() as {through:number|null};
  return row.through??0;
}

export function markInboxRead(store:EventStore):{marked:number} {
  return store.db.transaction(()=>{
    const previous=inboxReadBoundary(store);
    const {through}=store.db.prepare("SELECT COALESCE(max(rowid),0) AS through FROM inbound_events WHERE account_id='account_001'").get() as {through:number};
    const {marked}=store.db.prepare("SELECT count(*) AS marked FROM inbound_events WHERE account_id='account_001' AND status<>'BASELINE' AND rowid>?").get(previous) as {marked:number};
    if(through>previous)store.audit('INBOX_MARKED_READ','account_001',{through,marked});
    return {marked};
  }).immediate();
}
