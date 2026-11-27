import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {EventStore} from '../storage/store.js';
import type {AutomationStore} from '../storage/automation-store.js';
import type {WorkbenchAuthority} from '../app/authority.js';
import type {AiSettings} from '../app/contracts.js';
import {requireSafe} from '../core/contracts.js';
import {assertSecurityRevision,securityRevision} from '../storage/security-holds.js';
import {ReplyKnowledgeStore} from './store.js';
import {migrateReplyKnowledge} from './migration.js';
import {KnowledgeImports} from './imports.js';
import {OnnxEmbeddingManager,sanitizeEmbeddingStatus} from './embedding-engine.js';
import {LearningModelService,recoverLearningTasks,type LearningModelContext} from './model-service.js';
import type {ModelProviderController} from '../app/model-provider-controller.js';
import {replySettingsFingerprint} from './generation-context.js';
import type {KnowledgeCommand} from './commands.js';

interface State {settings:AiSettings;models:ModelProviderController|null;modelUnavailable:string|null;automation:AutomationStore|null;signal:AbortSignal;closing:boolean}
export class ReplyKnowledgeService {
  readonly data:ReplyKnowledgeStore;
  readonly embeddings:OnnxEmbeddingManager;
  private imports:KnowledgeImports;
  private model=new LearningModelService();
  private modelBusy=false;
  private lastCollected=0;
  constructor(private store:EventStore,private authority:WorkbenchAuthority,private root:string,private state:()=>State){
    this.embeddings=new OnnxEmbeddingManager({cacheRoot:join(root,'models','onnx')});
    this.data=new ReplyKnowledgeStore(store,{embeddingManager:this.embeddings});
    this.imports=new KnowledgeImports(root);
  }
  async initialize(){
    await migrateReplyKnowledge(this.store,join(this.root,'backups',`knowledge-${randomUUID()}.sqlite`));
    recoverLearningTasks(this.store);
    await this.imports.cleanup();
  }
  collectIfDue(){
    if(Date.now()-this.lastCollected<60_000||!this.data.available()||this.state().automation?.state().emergencyStopped)return;
    this.lastCollected=Date.now();this.data.collectCandidates(this.authority.accountId);
  }
  async dispatch(token:string,command:KnowledgeCommand):Promise<unknown>{
    const check=()=>{
      this.authority.operator(token,'CONTROL');requireSafe(this.authority.assistantVersion(token)===null,'KNOWLEDGE_GUI_ONLY');
      requireSafe(!this.state().closing,'CLIENT_CLOSING');requireSafe(this.data.available(),'KNOWLEDGE_NOT_READY');
    };check();const accountId=this.authority.accountId;
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
      case 'debugRetrieval':{
        const debug=this.data.debugRetrieval(accountId,command.channel,command.query,{
          ...(command.sourceIds?{sourceIds:command.sourceIds}:{}),
          ...(command.minScore!==undefined?{minScore:command.minScore}:{}),
        });
        return {...debug,onnxStatus:sanitizeEmbeddingStatus(debug.onnxStatus)};
      }
      case 'embeddingStatus':return sanitizeEmbeddingStatus(this.data.embeddingStatus());
      case 'analyze':case 'tryReply':{
        requireSafe(!this.modelBusy,'KNOWLEDGE_MODEL_BUSY');const before=this.state(),auto=before.automation;
        const controller=before.models;
        requireSafe(auto&&controller,before.modelUnavailable??'REAL_MODEL_AUTHORIZATION_REQUIRED');
        const grant=controller.guard.eligibleGrant('MODEL')??controller.guard.eligibleGrant('AUTO_REPLY');
        requireSafe(grant,'REAL_MODEL_AUTHORIZATION_REQUIRED');
        const snapshot=controller.guard.snapshot(grant,command.action==='analyze'?'PERSONA_ANALYSIS':'SANDBOX_REPLY');
        const settingsDigest=replySettingsFingerprint(before.settings,undefined);
        const channels=command.action==='tryReply'?[command.channel]:grant.scope.channels;
        const security=channels.map(channel=>({channel,revision:securityRevision(this.store,channel)}));
        const modelCheck=(requiredCalls=0)=>{
          check();controller.guard.assertCurrent(snapshot,grant.kind);
          const current=controller.guard.eligibleGrant('MODEL')??controller.guard.eligibleGrant('AUTO_REPLY');
          requireSafe(current?.version===grant.version,'GRANT_REVOKED');
          const fresh=this.state();requireSafe(!before.signal.aborted&&
            replySettingsFingerprint(fresh.settings,undefined)===settingsDigest,'MODEL_PAUSED');
          requireSafe(!auto.state().emergencyStopped,'EMERGENCY_STOPPED');
          auto.requireAccount(grant.scope.ownId);
          const used=this.store.db.prepare("SELECT count(*) used FROM grant_reservations WHERE grant_version=? AND kind='MODEL'")
            .get(grant.version) as {used:number};
          requireSafe(grant.scope.modelLimit===null||grant.scope.modelLimit-used.used>=requiredCalls,'MODEL_GRANT_EXHAUSTED');
          for(const {channel,revision} of security){
            requireSafe(grant.scope.channels.includes(channel),'MODEL_CHANNEL_NOT_AUTHORIZED');
            assertSecurityRevision(this.store,channel,revision);
          }
        };modelCheck();
        const context:LearningModelContext={store:this.store,settings:before.settings,key:'',accountId,allowedChannels:grant.scope.channels,signal:before.signal,embeddingManager:this.embeddings,check:modelCheck,route:purpose=>({controller,kind:grant.kind,snapshot:Object.freeze({...snapshot,purpose})}),
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
