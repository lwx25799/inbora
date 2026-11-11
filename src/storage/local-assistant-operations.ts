import {digest,requireSafe} from '../core/contracts.js';
import type {EventStore} from './store.js';

export interface AssistantOperation {
  operationId:string;tool:string;grantVersion:number;eventId:string|null;
  state:'RUNNING'|'SUCCEEDED'|'FAILED'|'UNKNOWN';result:unknown;error:string|null;createdAt:number;updatedAt:number;
}
interface Row {operation_id:string;tool:string;input_digest:string;grant_version:number;event_id:string|null;
  state:AssistantOperation['state'];result_json:string|null;error:string|null;created_at:number;updated_at:number}
export class LocalAssistantOperations {
  constructor(readonly store:EventStore,readonly now:()=>number=Date.now){}
  get(id:string):AssistantOperation{
    const row=this.store.db.prepare('SELECT * FROM assistant_operations WHERE operation_id=?').get(id) as Row|undefined;
    requireSafe(row,'ASSISTANT_OPERATION_NOT_FOUND');
    return {operationId:id,tool:row.tool,grantVersion:row.grant_version,eventId:row.event_id,state:row.state,
      result:row.result_json===null?null:JSON.parse(row.result_json),error:row.error,createdAt:row.created_at,updatedAt:row.updated_at};
  }
  /** true means newly accepted; false means return/query the existing operation and never execute again. */
  begin(id:string,tool:string,params:unknown,grantVersion:number,eventId:string|null=null):boolean{
    return this.store.db.transaction(()=>{
      const previous=this.store.db.prepare('SELECT tool,input_digest FROM assistant_operations WHERE operation_id=?').get(id) as Pick<Row,'tool'|'input_digest'>|undefined;
      if(previous){requireSafe(previous.tool===tool&&previous.input_digest===digest(params),'OPERATION_PARAMETERS_CONFLICT');return false;}
      this.store.db.prepare("INSERT INTO assistant_operations VALUES(?,?,?,?,?,'RUNNING',NULL,NULL,?,?)")
        .run(id,tool,digest(params),grantVersion,eventId,this.now(),this.now());return true;
    }).immediate();
  }
  finish(id:string,result:unknown):void{
    const text=JSON.stringify(result);requireSafe(Buffer.byteLength(text)<=256_000,'ASSISTANT_RESULT_TOO_LARGE');
    this.store.db.prepare("UPDATE assistant_operations SET state='SUCCEEDED',result_json=?,error=NULL,updated_at=? WHERE operation_id=? AND state='RUNNING'")
      .run(text,this.now(),id);
  }
  fail(id:string,error:string):void{
    requireSafe(/^[A-Z][A-Z0-9_]{0,99}$/u.test(error),'INVALID_ERROR_CODE');
    this.store.db.prepare("UPDATE assistant_operations SET state='FAILED',error=?,updated_at=? WHERE operation_id=? AND state='RUNNING'").run(error,this.now(),id);
  }
  recover():void{
    // The command/intent ledger remains authoritative. Recovery never queues or resubmits anything.
    this.store.db.prepare("UPDATE assistant_operations SET state='UNKNOWN',error='RESTART_NO_REPLAY',updated_at=? WHERE state='RUNNING'").run(this.now());
  }
}
