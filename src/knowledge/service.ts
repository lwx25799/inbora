import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {EventStore} from '../storage/store.js';
import type {AutomationStore} from '../storage/automation-store.js';
import type {WorkbenchAuthority} from '../app/authority.js';
import type {AiSettings} from '../app/contracts.js';
import {digest,requireSafe} from '../core/contracts.js';
import {assertSecurityChannelClear} from '../storage/security-holds.js';
import {ReplyKnowledgeStore} from './store.js';
import {migrateReplyKnowledge} from './migration.js';
import {KnowledgeImports} from './imports.js';
import {LearningModelService,type LearningModelContext} from './model-service.js';
import type {KnowledgeCommand} from './commands.js';

interface State {settings:AiSettings;key:string;automation:AutomationStore|null;signal:AbortSignal;closing:boolean}
export class ReplyKnowledgeService {
  readonly data:ReplyKnowledgeStore;
  private imports:KnowledgeImports;
  private model=new LearningModelService();
  private modelBusy=false;
  private lastCollected=0;
  constructor(private store:EventStore,private authority:WorkbenchAuthority,private root:string,private state:()=>State){
    this.data=new ReplyKnowledgeStore(store);this.imports=new KnowledgeImports(root);
  }
  async initialize(){await migrateReplyKnowledge(this.store,join(this.root,'backups',`knowledge-${randomUUID()}.sqlite`));await this.imports.cleanup();}
  collectIfDue(){
    if(Date.now()-this.lastCollected<60_000||!this.data.available()||this.state().automation?.state().emergencyStopped)return;
    this.lastCollected=Date.now();this.data.collectCandidates('account_001');
  }
  async dispatch(token:string,command:KnowledgeCommand):Promise<unknown>{
    const check=()=>{
      this.authority.operator(token,'CONTROL');requireSafe(this.authority.assistantVersion(token)===null,'KNOWLEDGE_GUI_ONLY');
      requireSafe(!this.state().closing,'CLIENT_CLOSING');requireSafe(this.data.available(),'KNOWLEDGE_NOT_READY');
    };check();const accountId='account_001';
    switch(command.action){
      case 'overview':return this.data.overview(accountId,command.page);
      case 'saveKnowledge':return this.data.saveKnowledge(accountId,command.input);
      case 'setKnowledgeState':return this.data.setKnowledgeState(accountId,command.id,command.state);
      case 'deleteSource':return this.data.deleteSource(accountId,command.sourceId);
      case 'selectSamples':return this.data.selectSamples(accountId,command.ids,command.accepted);
      case 'collectCandidates':return this.data.collectCandidates(accountId);
      case 'savePersona':return this.data.savePersona(accountId,command.text,command.sampleIds);
      case 'publishPersona':return this.data.publishPersona(accountId,command.id);
      case 'importStart':return this.imports.start(command.name,command.bytes,command.kind);
      case 'importChunk':return this.imports.chunk(command.id,command.index,command.data);
      case 'importFinish':return this.imports.finish(command.id);
      case 'importPreviewMapping':return this.imports.previewMapping(command.id,command.mapping);
      case 'importCommit':return this.imports.commit(command.id,this.data,accountId,command.mapping);
      case 'importCancel':await this.imports.cancel(command.id);return{cancelled:true};
      case 'analyze':case 'tryReply':{
        requireSafe(!this.modelBusy,'KNOWLEDGE_MODEL_BUSY');const before=this.state(),auto=before.automation;
        const grant=auto?.active('MODEL')??auto?.active('AUTO_REPLY');
        requireSafe(auto&&grant&&before.key,'REAL_MODEL_AUTHORIZATION_REQUIRED');
        const settingsDigest=digest(command.action==='tryReply'?before.settings:before.settings.model);
        const modelCheck=(requiredCalls=0)=>{
          check();const fresh=this.state();requireSafe(!before.signal.aborted&&fresh.key===before.key&&
            digest(command.action==='tryReply'?fresh.settings:fresh.settings.model)===settingsDigest,'MODEL_PAUSED');
          requireSafe(!auto.state().emergencyStopped,'EMERGENCY_STOPPED');
          auto.requireAccount(grant.scope.ownId);
          requireSafe(auto.active(grant.kind)?.version===grant.version&&grant.scope.model===before.settings.model,'GRANT_REVOKED');
          const used=this.store.db.prepare("SELECT count(*) used FROM grant_reservations WHERE grant_version=? AND kind='MODEL'")
            .get(grant.version) as {used:number};
          requireSafe(grant.scope.modelLimit===null||grant.scope.modelLimit-used.used>=requiredCalls,'MODEL_GRANT_EXHAUSTED');
          const channels=command.action==='tryReply'?[command.channel]:grant.scope.channels;
          for(const channel of channels){requireSafe(grant.scope.channels.includes(channel),'MODEL_CHANNEL_NOT_AUTHORIZED');assertSecurityChannelClear(this.store,channel);}
        };modelCheck();
        const context:LearningModelContext={store:this.store,settings:before.settings,key:before.key,accountId,allowedChannels:grant.scope.channels,signal:before.signal,check:modelCheck,
          reserve:(callId)=>{modelCheck();auto.reserve(grant.version,'MODEL',callId);}};
        this.modelBusy=true;
        try{return command.action==='analyze'?await this.model.analyze(context,command):await this.model.tryReply(context,command);}
        finally{this.modelBusy=false;}
      }
    }
  }
  async cancelActiveParse(){await this.imports.cancelActiveParse();}
  async close(){await this.imports.close();}
}
