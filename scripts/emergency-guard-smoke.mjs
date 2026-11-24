import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Exercise browser-serialized functions under both actual project compilation chains.
export async function runEmergencyGuardSmoke(source=false){
  const loader=source?(await import('tsx/esm/api')).register({namespace:'inbora-emergency-guard-smoke'}):null;
  const loadModule=url=>loader?loader.import(url,import.meta.url):import(url);
  try{
    const root=source?'src':'dist',extension=source?'ts':'js';
    const module=name=>loadModule(pathToFileURL(resolve(root,`${name}.${extension}`)).href);
    const load=name=>module('adapters/'+name);
    const {DEFAULT_ACCOUNT_ID}=await module('contracts/account');
    const {captureObserved}=await load('observed-capture');
    const {captureCommentThread}=await load('comment-thread-capture');
    const {hasVisibleSecurityComponent}=await load('security-components');
    const {captureDmReply}=await load('observed-dm-reply');
    const {captureCommentReply}=await load('observed-comment-reply');
    const {captureAndGuard,releaseMappedPreparation}=await load('click-guard');
    const {inspectMessageImage}=await load('message-preview');
    const {inspectMessageShare}=await load('message-share');
    const {visibleStoredMessage}=await load('message-view-location');
    const {inspectSecuritySignal}=await load('security-inspection');
    const {claimFreshCommentDocument,markCommentDocumentRead}=await load('fresh-comment-document');
    const {inspectRecoveryNavigation}=await module('app/browser-recovery-locations');
    const {manualRecoveryElements,inspectManualRecoveryElement}=await module('browser/manual-recovery-dom');
    const {installMediaPauseDocument,releaseMediaPauseDocument}=await module('browser/media-pause');
    function context(title='',visibleBlocker=false,origin='https://www.douyin.com',width=320,height=180){
      const blocker={tagName:'IFRAME',id:'synthetic-security',isConnected:true,parentElement:null,childNodes:[],querySelectorAll:()=>[],
        getBoundingClientRect:()=>({left:0,top:0,right:width,bottom:height,width,height}),getClientRects:()=>[{left:0,top:0,right:width,bottom:height,width,height}]};
      return {window:{},innerWidth:1280,innerHeight:720,performance:{timeOrigin:1000},location:{origin,href:origin+'/video/work'},document:{title,
        querySelectorAll:selector=>selector==='.security'&&visibleBlocker?[blocker]:[]},
        getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})};
    }
    const mapping={origin:'https://www.douyin.com',securityBlockers:'.security',
      works:[{id:'work',url:'https://www.douyin.com/video/work'}],peers:[{uid:'peer',conversationId:'chat'}],selectors:{selfAvatar:'.self'}};
    const observed={mapping,channel:'identity',accountId:DEFAULT_ACCOUNT_ID,index:0,evidenceId:'synthetic-only'};
    const thread={mapping,event:{videoId:'work'},action:'inspect',offset:0};
    let checked=0;
    function rejects(fn,input,environment,code){
      const invoke=runInNewContext(`(${fn.toString()})`,environment);
      assert.throws(()=>invoke(input),error=>error?.message===code||code==='OBSERVATION_SECURITY_SUSPECT'&&error?.message.startsWith(code+' INBORA_SECURITY_SIGNAL:'));checked++;
    }
    rejects(captureObserved,observed,context('',false,'https://example.invalid'),'OBSERVATION_UNEXPECTED_ORIGIN');
    for(const title of ['验证码','安全验证','访问受限'])for(const [fn,input] of [[captureObserved,observed],[captureCommentThread,thread]])
      rejects(fn,input,context(title,true),'OBSERVATION_SECURITY_SUSPECT');
    for(const [fn,input] of [[captureObserved,observed],[captureCommentThread,thread]])
      rejects(fn,input,context('',true),'OBSERVATION_SECURITY_SUSPECT');
    rejects(captureObserved,observed,context(),'OBSERVATION_ACCOUNT_AVATAR_DOM_NOT_READY');
    rejects(captureCommentThread,thread,context(),'OBSERVATION_ACCOUNT_CHANGED');
    for(const [width,height] of [[0,0],[0,40],[40,0]]){
      rejects(captureObserved,observed,context('',true,undefined,width,height),'OBSERVATION_ACCOUNT_AVATAR_DOM_NOT_READY');
      rejects(captureCommentThread,thread,context('',true,undefined,width,height),'OBSERVATION_ACCOUNT_CHANGED');
    }
    for(const [width,height,expected] of [[0,0,false],[0,40,false],[40,0,false],[320,180,true]]){
      const invoke=runInNewContext(`(${hasVisibleSecurityComponent.toString()})`,context('',true,undefined,width,height));
      assert.equal(invoke(['.security']),expected);checked++;
    }
    const dmEvent={accountId:DEFAULT_ACCOUNT_ID,channel:'DIRECT_MESSAGE',direction:'INCOMING',kind:'DM',actorId:'peer',conversationId:'chat',platformEventId:'message',occurredAt:'synthetic'},
      commentEvent={...dmEvent,channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'work'},replyMapping={observation:mapping,blockers:'.dialog'};
    for(const [fn,input] of [[captureDmReply,{mapping:replyMapping,event:dmEvent,action:'snapshot'}],
      [captureCommentReply,{mapping:replyMapping,event:commentEvent,action:'snapshot'}],
      [inspectMessageShare,{mapping,event:dmEvent,peer:mapping.peers[0]}],[visibleStoredMessage,{mapping,accountId:DEFAULT_ACCOUNT_ID,event:dmEvent,peer:mapping.peers[0]}]])
      rejects(fn,input,context('',true),'OBSERVATION_SECURITY_SUSPECT');

    function storedMessageFixture(){
      const env=context(),rect={left:20,top:20,right:120,bottom:70};
      const element=(properties={})=>({isConnected:true,parentElement:null,getClientRects:()=>[rect],getBoundingClientRect:()=>rect,
        classList:{contains:()=>false},...properties});
      const createdAt=new Date('2026-11-05T00:00:00Z'),peer={...mapping.peers[0],secUid:'peer-sec',title:'Fixture peer'};
      const own={uid:'own',secUid:'own-sec'};
      const reactProps=props=>({__reactProps$fixture:{children:{props}}});
      const avatar=element({__reactFiber$fixture:{memoizedProps:own}});
      const header=element(reactProps({conversation:{id:peer.conversationId,_toParticipantSecUserId:peer.secUid}}));
      const title=element({textContent:peer.title});
      const box=element({contains:node=>node===row||node===box});
      const row=element({...reactProps({message:{serverId:dmEvent.platformEventId,conversationId:peer.conversationId,sender:peer.uid,createdAt}}),
        closest:()=>box,parentElement:box});
      const chat=element({querySelectorAll:selector=>({'#header':[header],'#title':[title],'.row':[row]}[selector]??[]),
        contains:node=>node===box});
      env.document.querySelectorAll=selector=>({'#self':[avatar],'#chat':[chat]}[selector]??[]);
      const input={accountId:DEFAULT_ACCOUNT_ID,peer,event:{...dmEvent,videoId:null,commentId:null,occurredAt:createdAt.toISOString()},
        mapping:{...mapping,self:own,selectors:{selfAvatar:'#self',selfFiberDepth:0,chat:'#chat',chatHeader:'#header',chatTitle:'#title',
          messages:'.row',messageBox:'.box',fromMeClass:'from-me'}}};
      return {env,input};
    }
    const view=storedMessageFixture(),locate=runInNewContext(`(${visibleStoredMessage.toString()})`,view.env);
    assert.equal(locate(view.input),true);checked++;
    const nonDefault={...view.input,accountId:'account_002',event:{...view.input.event,accountId:'account_002'}};
    assert.equal(locate(nonDefault),true);checked++;
    rejects(visibleStoredMessage,{...nonDefault,event:{...nonDefault.event,accountId:DEFAULT_ACCOUNT_ID}},view.env,'MESSAGE_VIEW_TARGET_CHANGED');
    rejects(visibleStoredMessage,{...view.input,accountId:'account_002'},view.env,'MESSAGE_VIEW_TARGET_CHANGED');

    await assert.rejects(runInNewContext(`(${inspectMessageImage.toString()})`,context('',true))({mapping,event:dmEvent,imageIndex:0,peer:mapping.peers[0]}),
      error=>error?.message.startsWith('OBSERVATION_SECURITY_SUSPECT INBORA_SECURITY_SIGNAL:'));checked++;
    rejects(captureAndGuard,{mapping:{...mapping,targets:{DIRECT_MESSAGE:{}},guards:{challenge:'.security',loginRequired:'.none',stopped:'.none'}},
      event:dmEvent,accountId:DEFAULT_ACCOUNT_ID,channel:'DIRECT_MESSAGE'},context('',true),'CLICK_DOM_GUARD_BLOCKED');
    rejects(captureAndGuard,{mapping:{...mapping,targets:{DIRECT_MESSAGE:{}}},event:dmEvent,accountId:'fixture-other',channel:'DIRECT_MESSAGE'},
      context(),'CLICK_DOM_GUARD_BLOCKED');

    function legacyPrepareFixture(kind='textarea'){
      const env=context(),attrs={id:'comment',actor:'peer',video:'work',time:'fixture',kind:'COMMENT',direction:'INCOMING'};
      class Element{
        constructor(attributes){this.attributes=attributes;this.listeners=new Map();}
        getAttribute(name){return this.attributes[name]??null;}
        getClientRects(){return this.hidden?[]:[{}];}
        querySelectorAll(){return [];}
        matches(){return false;}
        closest(){return null;}
        addEventListener(type,listener){this.listeners.set(type,listener);}
        removeEventListener(type,listener){if(this.listeners.get(type)===listener)this.listeners.delete(type);}
      }
      let value='Human draft',events=0,clicks=0;
      class HTMLTextAreaElement extends Element{
        get value(){return value;}
        set value(text){value=text;}
        matches(){return false;}
        dispatchEvent(){events++;}
      }
      class HTMLElement extends Element{
        isContentEditable=true;
        isConnected=true;
        children=[];
        childNodes=[];
        get textContent(){return value;}
        set textContent(text){value=text;}
        get innerHTML(){return value+this.children.map(child=>'<'+child.tagName.toLowerCase()+'>').join('');}
        dispatchEvent(){events++;}
        replaceChildren(...nodes){value='';this.children=[...nodes];this.childNodes=[...nodes];}
      }
      class HTMLInputElement extends HTMLTextAreaElement{
        type='text';
        get value(){return super.value;}
        set value(text){super.value=text.replace(/[\r\n]/gu,'');}
      }
      const Composer=kind==='editable'?HTMLElement:kind==='input'?HTMLInputElement:HTMLTextAreaElement;
      const root=new Element(attrs),own=new Element({id:'self'}),composer=new Composer({key:'comment:work:comment'});
      const button=new HTMLElement({});
      env.window=new Element({});
      button.click=()=>{
        let blocked=false;
        const event={type:'click',currentTarget:env.window,composedPath:()=>[button,env.window],
          preventDefault(){blocked=true;},stopImmediatePropagation(){blocked=true;}};
        env.window.listeners.get('click')?.(event);
        if(!blocked){event.currentTarget=button;button.listeners.get('click')?.(event);}
        if(!blocked)clicks++;
      };
      root.textContent='fixture';
      env.document.querySelectorAll=selector=>({'#own':[own],'#root':[root],'#editor':[composer],'#send':[button]}[selector]??[]);
      Object.assign(env,{Element,HTMLElement,HTMLTextAreaElement,HTMLInputElement,HTMLAnchorElement:class extends HTMLElement{},InputEvent:class{}});
      const guards={loggedIn:'#own',ownIdentity:{selector:'#own',attribute:'id'},loginRequired:'.none',challenge:'.none',stopped:'.none'};
      const fields={platformEventId:{attribute:'id'},actorId:{attribute:'actor'},videoId:{attribute:'video'},commentId:{attribute:'id'},
        conversationId:null,text:{},occurredAt:{attribute:'time'},direction:{attribute:'direction'},kind:{attribute:'kind'}};
      const target={roots:'#root',fields,composer:'#editor',composerTarget:{attribute:'key'},outgoingRows:'.outgoing',send:'#send'};
      const input={mapping:{origin:mapping.origin,ownId:'self',guards,targets:{COMMENT_NOTIFICATION:target},
        directionValues:{INCOMING:'INCOMING'},kindValues:{COMMENT:'COMMENT'}},channel:'COMMENT_NOTIFICATION',accountId:DEFAULT_ACCOUNT_ID,
        event:{...commentEvent,platformEventId:'comment',commentId:'comment',conversationId:null,occurredAt:'fixture',text:'fixture'},
        text:null,token:null,prepare:'Approved draft',preparationToken:'fixture-preparation'};
      return {env,input,composer,button,own,events:()=>events,clicks:()=>clicks};
    }
    const legacy=legacyPrepareFixture(),prepare=runInNewContext(`(${captureAndGuard.toString()})`,legacy.env);
    assert.equal(prepare(legacy.input).existingDraft,true);
    assert.equal(legacy.composer.value,'Human draft');assert.equal(legacy.events(),0);checked++;
    legacy.composer.value='';
    assert.equal(prepare(legacy.input).existingDraft,undefined);
    assert.equal(legacy.composer.value,'Approved draft');assert.equal(legacy.events(),1);checked++;

    const editable=legacyPrepareFixture('editable'),prepareEditable=runInNewContext(`(${captureAndGuard.toString()})`,editable.env);
    assert.equal(prepareEditable(editable.input).existingDraft,true);
    assert.equal(editable.composer.textContent,'Human draft');assert.equal(editable.events(),0);checked++;
    editable.composer.textContent='';
    assert.equal(prepareEditable(editable.input).existingDraft,undefined);
    assert.equal(editable.composer.textContent,'Approved draft');assert.equal(editable.events(),1);checked++;
    editable.composer.children.push({tagName:'BR'});
    assert.throws(()=>prepareEditable({...editable.input,prepare:undefined,text:'Approved draft',token:'fixture-preparation'}),
      /CLICK_DOM_GUARD_BLOCKED/u);checked++;
    assert.equal(editable.composer.textContent,'Approved draft');assert.equal(editable.events(),1);

    const singleLine=legacyPrepareFixture('input');singleLine.composer.value='';
    const prepareInput=runInNewContext(`(${captureAndGuard.toString()})`,singleLine.env);
    assert.throws(()=>prepareInput({...singleLine.input,prepare:'first\nsecond'}),/SINGLE_LINE/u);
    assert.equal(singleLine.composer.value,'');assert.equal(singleLine.events(),0);checked++;

    const arm={...editable.input,prepare:undefined,text:'Approved draft',token:editable.input.preparationToken};
    editable.composer.children.length=0;
    prepareEditable(arm);
    editable.composer.children.push({tagName:'IMG'});
    assert.throws(()=>editable.env.window.__inboraGate.submit(),/CLICK_DOM_GUARD_BLOCKED/u);
    assert.equal(editable.clicks(),0);checked++;
    const release=runInNewContext(`(${releaseMappedPreparation.toString()})`,editable.env);
    release({token:'wrong-preparation',discard:true});
    assert.equal(editable.env.window.listeners.size,2);checked++;
    release({token:arm.token,discard:true});
    assert.equal(editable.composer.textContent,'Approved draft');
    assert.equal(editable.composer.children[0]?.tagName,'IMG');
    assert.equal(editable.env.window.listeners.size,0);
    editable.button.click();assert.equal(editable.clicks(),1);checked++;

    const clean=legacyPrepareFixture('editable'),cleanCapture=runInNewContext(`(${captureAndGuard.toString()})`,clean.env);
    const cleanRelease=runInNewContext(`(${releaseMappedPreparation.toString()})`,clean.env);
    clean.composer.textContent='';
    cleanCapture(clean.input);cleanCapture({...clean.input,...arm,mapping:clean.input.mapping,event:clean.input.event});
    assert.equal(clean.env.window.__inboraGate.submit(),true);
    cleanRelease({token:arm.token,discard:false});clean.button.click();
    assert.equal(clean.clicks(),2);checked++;
    clean.composer.textContent='';cleanCapture(clean.input);
    cleanCapture({...clean.input,...arm,mapping:clean.input.mapping,event:clean.input.event});
    cleanRelease({token:arm.token,discard:true});
    assert.equal(clean.composer.textContent,'');assert.equal(clean.env.window.listeners.size,0);
    clean.button.click();assert.equal(clean.clicks(),3);checked++;
    cleanCapture(clean.input);
    clean.composer.listeners.get('input')?.();
    cleanRelease({token:arm.token,discard:true});
    assert.equal(clean.composer.textContent,'Approved draft');assert.equal(clean.composer.listeners.size,0);checked++;

    const legacyNav={mapping:legacy.input.mapping,channel:legacy.input.channel,accountId:legacy.input.accountId,
      navigation:{selector:'#send'}};
    legacy.composer.hidden=true;
    assert.throws(()=>prepare(legacyNav),/BROWSER_HAS_HUMAN_INPUT/u);
    assert.equal(legacy.clicks(),0);checked++;
    legacy.composer.value='';legacy.own.attributes.id='other';
    assert.throws(()=>prepare(legacyNav),/ACCOUNT_NOT_VERIFIED/u);
    assert.equal(legacy.clicks(),0);checked++;
    legacy.own.attributes.id='self';
    const query=legacy.env.document.querySelectorAll;
    const blocked=context('',true);
    legacy.env.document.querySelectorAll=selector=>selector==='.security'?blocked.document.querySelectorAll(selector):query(selector);
    const guardedNav={...legacyNav,mapping:{...legacyNav.mapping,guards:{...legacyNav.mapping.guards,challenge:'.security'}}};
    assert.throws(()=>prepare(guardedNav),/CHALLENGE_REQUIRED/u);
    assert.equal(legacy.clicks(),0);checked++;
    prepare(legacyNav);assert.equal(legacy.clicks(),1);checked++;

    const inspect=runInNewContext(`(${inspectSecuritySignal.toString()})`,context('',true));
    assert.equal(inspect({selectors:['.security']}).state,'SUSPECT');checked++;
    for(const [origin,empty] of [['https://www.douyin.com',true],['https://example.invalid',false]]){
      const environment=context('',false,origin),invoke=runInNewContext(`(${inspectRecoveryNavigation.toString()})`,environment);
      const result=invoke({origin:'https://www.douyin.com',composers:[]});assert.equal(result.originMatches,empty);assert.equal(result.empty,empty);checked++;
    }
    for(const scenario of ['hidden-value','collapsed-attachment','empty-editor','unmapped-hidden-input']){
      const env=context();
      class HTMLTextAreaElement{}
      class HTMLInputElement{}
      Object.assign(env,{HTMLTextAreaElement,HTMLInputElement});
      const editor=Object.assign(scenario==='hidden-value'?new HTMLTextAreaElement():
        scenario==='unmapped-hidden-input'?new HTMLInputElement():{},{
        value:'preserved draft',type:'hidden',textContent:'',matches:()=>false,children:[],
        getBoundingClientRect:()=>({width:0,height:0}),querySelector:()=>null,querySelectorAll:()=>[],
      });
      const mapped=scenario==='collapsed-attachment';
      if(mapped)editor.querySelector=()=>({tagName:'IMG'});
      env.getComputedStyle=()=>({display:scenario==='hidden-value'?'none':'block',visibility:'visible'});
      env.document.querySelectorAll=selector=>selector==='.mapped-composer'?(mapped?[editor]:[]):mapped?[]:[editor];
      const inspectDraft=runInNewContext(`(${inspectRecoveryNavigation.toString()})`,env);
      for(const origin of [undefined,env.location.origin]){
        assert.equal(inspectDraft({origin,composers:['.mapped-composer']}).empty,
          scenario==='empty-editor'||scenario==='unmapped-hidden-input',scenario);checked++;
      }
    }
    for(const scenario of ['empty','unmapped','legacy','attachment','void','invalid-node','draft']){
      const env=context(),selector='#native-editor';
      const value=scenario==='draft'?'\u200Bunsent draft':'\u200B';
      const child={nodeType:3};
      const editor={textContent:value,children:[],childNodes:scenario==='invalid-node'?[child,{nodeType:8}]:[child],firstChild:child,
        matches:query=>query===selector&&scenario!=='unmapped'||query.includes('[contenteditable=')||
          scenario==='void'&&query.includes('[data-slate-void="true"]'),
        querySelector:query=>scenario==='attachment'&&query.includes('[data-attachment]')?{}:null,querySelectorAll:()=>[],
        getBoundingClientRect:()=>({width:0,height:0})};
      Object.assign(env,{HTMLInputElement:class{},HTMLTextAreaElement:class{},Node:{TEXT_NODE:3},
        getComputedStyle:()=>({display:'none',visibility:'hidden'})});
      const mapped=scenario!=='unmapped';
      env.document.querySelectorAll=query=>query===selector&&!mapped?[]:[editor];
      const inspectDraft=runInNewContext(`(${inspectRecoveryNavigation.toString()})`,env);
      for(const origin of [undefined,env.location.origin]){
        const input={origin,composers:mapped?[selector]:[],nativeDmComposer:scenario==='legacy'?undefined:selector};
        assert.equal(inspectDraft(input).empty,scenario==='empty',scenario);checked++;
      }
    }
    for(const withBreak of [false,true]){
      const env=context(),textContent='\u200B',text={nodeType:3,textContent},br={tagName:'BR'};
      const span={tagName:'SPAN',matches:selector=>selector==='span[data-enter="true"][data-string="true"][data-leaf="true"]',
        firstChild:text,childNodes:withBreak?[text,br]:[text]};
      const line={tagName:'DIV',matches:selector=>selector==='div.ace-line[data-node="true"]',
        firstElementChild:span,children:[span],childNodes:[span]};
      const editor={textContent,matches:selector=>selector==='[data-slate-editor="true"][data-zone-container="*"]',
        firstElementChild:line,children:[line],childNodes:[line],querySelector:()=>null,
        querySelectorAll:()=>withBreak?[line,span,br]:[line,span]};
      Object.assign(env,{HTMLInputElement:class{},HTMLTextAreaElement:class{},Node:{TEXT_NODE:3}});
      env.document.querySelectorAll=()=>[editor];
      const inspectDraft=runInNewContext(`(${inspectRecoveryNavigation.toString()})`,env);
      assert.equal(inspectDraft({composers:[]}).empty,!withBreak,withBreak?'legacy placeholder with BR':'legacy placeholder');checked++;
    }
    let documentStartedAt=100_000,documentNow=120_000;
    const documentUrl='https://www.douyin.com/video/work';
    const documentPage={evaluate:async fn=>runInNewContext(`(${fn.toString()})()`,{
      location:{href:documentUrl},performance:{timeOrigin:documentStartedAt},Date:{now:()=>documentNow},
    })};
    async function fresh(expected,url=documentUrl,age=30_000){
      assert.equal(await claimFreshCommentDocument(documentPage,url,age),expected);checked++;
    }
    await fresh(true);await fresh(false);
    documentStartedAt=110_000;await markCommentDocumentRead(documentPage);await fresh(false);
    documentStartedAt=115_000;await fresh(false,'https://www.douyin.com/video/other');await fresh(true);
    documentStartedAt=116_000;documentNow=150_000;await fresh(false);
    documentNow=120_000;await fresh(true);await fresh(false);
    // Verify manual-recovery-dom serialized functions under both tsx and built Node.
    const challengeFrame={tagName:'IFRAME',isConnected:true,parentElement:null,
      getBoundingClientRect:()=>({left:450,top:186,right:830,bottom:534,width:380,height:348}),
      querySelectorAll:()=>[],contains:node=>node===challengeFrame};
    const recoveryEnv={innerWidth:1280,innerHeight:720,performance:{timeOrigin:1000},
      location:{href:'https://www.douyin.com/video/work'},
      document:{querySelectorAll:selector=>selector==='.security'?[challengeFrame]:[],
        elementFromPoint:()=>challengeFrame,activeElement:challengeFrame},
      getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible'})};
    const collectRecovery=runInNewContext(`(${manualRecoveryElements.toString()})`,recoveryEnv);
    const foundRecovery=collectRecovery({selectors:['.security']});
    assert.equal(foundRecovery.length,1);assert.equal(foundRecovery[0],challengeFrame);checked++;
    const inspectRecovery=runInNewContext(`(${inspectManualRecoveryElement.toString()})`,recoveryEnv);
    assert.deepEqual({...inspectRecovery(challengeFrame,{href:'https://www.douyin.com/video/work',started:1000,point:{x:480,y:215}}),
      region:{...inspectRecovery(challengeFrame,{href:'https://www.douyin.com/video/work',started:1000,point:{x:480,y:215}}).region}},
      {documentMatches:true,region:{x:450,y:186,width:380,height:348},permitted:true});checked++;
    assert.deepEqual({...inspectRecovery(challengeFrame,{href:'https://www.douyin.com/video/other',started:1000})},
      {documentMatches:false,region:null,permitted:false});checked++;
    // Verify media-pause serialized functions under both tsx and built Node.
    function mediaEnv(origin){
      let pauseCalls=0,disconnected=0;
      class Element{}
      class HTMLMediaElement extends Element{constructor(){super();this.isConnected=true;this.paused=false;}pause(){this.paused=true;pauseCalls++;}}
      class Document{constructor(media){this.isConnected=true;this._media=media;}querySelectorAll(){return [this._media];}addEventListener(){}removeEventListener(){}}
      class MutationObserver{observe(){}disconnect(){disconnected++;}}
      const media=new HTMLMediaElement(),doc=new Document(media),win={addEventListener(){},removeEventListener(){}};
      win.top=win;
      return{env:{window:win,location:{origin},document:doc,Element,HTMLMediaElement,Document,MutationObserver,Symbol,Reflect,Object},
        media,doc,state:()=>({pauseCalls,disconnected,installed:Reflect.has(doc,Symbol.for('inbora.media-pause.v1'))})};
    }
    const trusted=mediaEnv('https://www.douyin.com');
    runInNewContext(`(${installMediaPauseDocument.toString()})`,trusted.env)({trustedOrigin:'https://www.douyin.com'});
    assert.equal(trusted.media.paused,true);assert.deepEqual(trusted.state(),{pauseCalls:1,disconnected:0,installed:true});checked++;
    runInNewContext(`(${releaseMediaPauseDocument.toString()})`,trusted.env)();
    assert.deepEqual(trusted.state(),{pauseCalls:1,disconnected:1,installed:false});checked++;
    const untrusted=mediaEnv('https://example.invalid');
    runInNewContext(`(${installMediaPauseDocument.toString()})`,untrusted.env)({trustedOrigin:'https://www.douyin.com'});
    assert.equal(untrusted.media.paused,false);assert.deepEqual(untrusted.state(),{pauseCalls:0,disconnected:0,installed:false});checked++;
    return checked;
  }finally{await loader?.unregister();}
}

if(import.meta.main){
  const source=process.argv[2]==='source';
  const checked=await runEmergencyGuardSmoke(source);
  console.log(`${source?'tsx source':'built Node'} serialized emergency guards passed: ${checked} checks; no browser, runtime or Profile accessed`);
}
