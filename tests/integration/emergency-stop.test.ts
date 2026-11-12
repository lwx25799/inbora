import {afterEach,expect,test} from 'vitest';
import {EventStore} from '../../src/storage/store.js';
import {AutomationStore} from '../../src/storage/automation-store.js';

const stores:EventStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
function setup(){
  const store=new EventStore(':memory:',true);stores.push(store);
  store.db.exec(`CREATE TABLE automation_state(id INTEGER PRIMARY KEY,started_at INTEGER NOT NULL,
    emergency_stopped INTEGER NOT NULL DEFAULT 0,collection_json TEXT NOT NULL);
    CREATE TABLE collection_progress(source TEXT PRIMARY KEY,next_at INTEGER NOT NULL DEFAULT 0,
    last_success INTEGER,last_error TEXT,failures INTEGER NOT NULL DEFAULT 0,elapsed_ms INTEGER,cursor_json TEXT NOT NULL DEFAULT '{}');`);
  let now=Date.now();const auto=new AutomationStore(store,()=>now);auto.initialize(now);
  return {store,auto,advance:()=>{now+=1000;}};
}

test('an emergency atomically records a fixed cause, source and actual time across a store restart',()=>{
  const {store,auto}=setup(),stoppedAt=auto.now();
  const before=store.db.prepare('SELECT * FROM budgets ORDER BY kind').all();
  auto.stop(true,'OBSERVATION_SECURITY_COMPONENT','COLLECTION_COMMENTS');
  const restarted=new AutomationStore(store,()=>stoppedAt+10_000);
  expect(restarted.state()).toMatchObject({emergencyStopped:true,emergencyStop:{
    reason:'OBSERVATION_SECURITY_COMPONENT',source:'COLLECTION_COMMENTS',stoppedAt,legacy:false}});
  expect(store.db.prepare('SELECT * FROM budgets ORDER BY kind').all()).toEqual(before);
  expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
});

test('secondary stops preserve the original incident but fence an already running recovery check',()=>{
  const {auto,advance}=setup(),stoppedAt=auto.now();
  auto.stop(true,'OBSERVATION_SECURITY_TITLE','COLLECTION_DM');
  const first=auto.emergencyRevision();advance();auto.stop(true,'MANUAL_EMERGENCY_STOP','MANUAL');
  expect(auto.emergencyRevision()).not.toBe(first);
  expect(auto.state().emergencyStop).toEqual({reason:'OBSERVATION_SECURITY_TITLE',source:'COLLECTION_DM',stoppedAt,legacy:false});
  expect(auto.resumeEmergency(first)).toBe(false);
  expect(auto.state().emergencyStopped).toBe(true);
  expect(auto.resumeEmergency(auto.emergencyRevision())).toBe(true);
  expect(auto.state()).toMatchObject({emergencyStopped:false,emergencyStop:null});
});

test('a later incident records its own cause while retaining earlier audit evidence',()=>{
  const {store,auto,advance}=setup();auto.stop(true,'MANUAL_EMERGENCY_STOP','MANUAL');
  const first=auto.emergencyRevision();expect(auto.resumeEmergency(first)).toBe(true);advance();
  auto.stop(true,'ACCOUNT_CHANGED','CONNECTION');
  expect(auto.state().emergencyStop).toEqual({reason:'ACCOUNT_CHANGED',source:'CONNECTION',stoppedAt:auto.now(),legacy:false});
  expect(store.db.prepare('SELECT id FROM audit_events WHERE id=?').get(first)).toEqual({id:first});
});

test('legacy stopped state uses only a marked diagnostic hint with unknown original time',()=>{
  const {store,auto}=setup();store.db.prepare('UPDATE automation_state SET emergency_stopped=1').run();
  expect(auto.state().emergencyStop).toEqual({reason:'LEGACY_EMERGENCY_STOP',source:'UNKNOWN',stoppedAt:null,legacy:true});
  store.db.prepare("UPDATE collection_progress SET last_error='OBSERVATION_PAGE_BLOCKED',next_at=?,failures=1 WHERE source='works'").run(auto.now());
  expect(auto.state().emergencyStop).toEqual({reason:'OBSERVATION_PAGE_BLOCKED',source:'COLLECTION_COMMENTS',stoppedAt:null,legacy:true});
  const previous=auto.emergencyRevision();auto.stop(true,'MANUAL_EMERGENCY_STOP','MANUAL');
  expect(auto.state().emergencyStop?.legacy).toBe(true);
  expect(auto.resumeEmergency(previous)).toBe(false);
});

test('unrecognized errors cannot persist exception text or pretend to be a known safe cause',()=>{
  const {store,auto}=setup();auto.stop(true,'private-error-message','CONNECTION');
  expect(auto.state().emergencyStop).toMatchObject({reason:'EMERGENCY_REASON_UNKNOWN',source:'CONNECTION'});
  const history=JSON.stringify(store.db.prepare('SELECT event_type,detail_redacted FROM audit_events').all());
  expect(history).toContain('EMERGENCY_REASON_UNKNOWN');expect(history).not.toContain('private-error-message');
});

test('audit failure rolls back the stop flag instead of creating a stopped incident without its cause',()=>{
  const {store,auto}=setup();store.db.exec(`CREATE TRIGGER fail_stop_audit BEFORE INSERT ON audit_events
    WHEN NEW.event_type='EMERGENCY_STOPPED' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;`);
  expect(()=>auto.stop(true,'PLATFORM_STOP','AUTOMATIC_REPLY')).toThrow('synthetic audit failure');
  expect(auto.state()).toMatchObject({emergencyStopped:false,emergencyStop:null});
});
