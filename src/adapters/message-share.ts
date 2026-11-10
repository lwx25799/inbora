import type {InboundEvent} from '../core/contracts.js';
import type {ObservationMapping} from '../config/site-mapping.js';
import type {DiscoveredPeer} from './observed-reader.js';
import type {MessageShare} from '../storage/message-shares.js';

interface ShareFieldShape {key:string;type:'ABSENT'|'ACCESSOR'|'CONFLICT'|'STRING'|'NUMBER'|'BOOLEAN'|'NULL'|'ARRAY'|'OBJECT'|'OTHER';
  digitId:boolean;urlKind:'DOUYIN_VIDEO'|'DOUYIN_NOTE'|'OTHER_URL'|'NOT_URL';fields?:ShareFieldShape[]}
interface OwnershipPath {steps:{tag:'DIV'|'SPAN'|'IMG'|'VIDEO'|'AUDIO'|'A'|'BUTTON'|'P'|'BR'|'OTHER';childIndex:number|null}[];reachedRow:boolean;truncated:boolean}
interface MediaOwnershipShape {path:OwnershipPath;textRelation:'BEFORE'|'AFTER'|'CONTAINS'|'INSIDE'|'UNAVAILABLE';commonDepth:number|null;
  inRowRect:boolean;inTextRect:boolean;anchor:boolean;menu:boolean;dialog:boolean;ariaHidden:boolean;quote:boolean}
interface ModernShareShape {
  snakeItem:ShareFieldShape;schema:{type:ShareFieldShape['type'];kind:'AWEME_DETAIL'|'WEB_VIDEO'|'WEB_NOTE'|'OTHER'|'INVALID';
    itemMatchesSnake:boolean|null;itemMatchesCamel:boolean|null;itemMatchesAwemeItem:boolean|null;itemMatchesAwemeId:boolean|null};
  awemeInfo:{type:ShareFieldShape['type'];fields:ShareFieldShape[];awemeType:number|null;typeValue:number|null;itemMatchesSnake:boolean|null;awemeMatchesSnake:boolean|null};
  identityConflict:boolean;
}
interface ShareCalibration {
  nativeMessageKind:number|null;nativeRoute:'VIDEO'|'NOTE'|'UNAVAILABLE';
  routeReason:'LINKED'|'ITEM_CONFLICT'|'MULTIPLE_LINKS'|'MISSING_ITEM_ID'|'INVALID_SLIDES'|'UNKNOWN_ROUTE'|'NO_CARD_OR_NATIVE_SHARE';
  parsedScalars:ShareFieldShape[];related:{type:ShareFieldShape['type'];fields:ShareFieldShape[];truncated:boolean};modernShare?:ModernShareShape;
  text:{nativeType7:boolean;ownedTextCount:number;visibleTextCount:number;inlineImages:number;otherMedia:number;reconstructed:boolean;matchesNative:boolean;
    bodyReconstructed:boolean;bodyNonEmpty:boolean;bodyMatchesNative:boolean;textPath:OwnershipPath|null;mediaShapes:MediaOwnershipShape[];mediaShapesTruncated:boolean};
}
export interface ShareInspection {
  share:MessageShare|null;detected:boolean;displayText?:string|null;
  diagnostic:{anchors:number;cardMarkers:number;nativeItemIdPresent:boolean;nativeItemIdConflict:boolean;urlKinds:Record<string,number>;
    nativeKinds:{aweType:number|null;awemeType:number|null;isSlides:boolean|null};
    shareInfo:{type:string;fields:{key:string;type:string;urlKind:string}[]}[];parsedFields:{key:string;type:string;digitId:boolean}[];calibration?:ShareCalibration};
}
interface ShareInput {mapping:ObservationMapping;event:InboundEvent;peer:DiscoveredPeer}

/** Exact mapped native message only. No handler, getter, navigation, media request or text extraction. */
export function inspectMessageShare(input:ShareInput):ShareInspection {
  const {mapping:m,event,peer}=input,s=m.selectors;
  const dom={
    check(value:unknown):void{if(!value)throw Error('MESSAGE_SHARE_TARGET_CHANGED');},
    data(object:unknown,key:string):unknown{
      if(!object||typeof object!=='object')return undefined;
      const own=Object.getOwnPropertyDescriptor(object,key),inherited=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object)??{},key);
      dom.check((!own||Object.hasOwn(own,'value'))&&(!inherited||Object.hasOwn(inherited,'value'))&&(!own||!inherited||own.value===inherited.value));
      return own?own.value:inherited?.value;
    },
    visible(node:Element):boolean{
      if(!node.isConnected||!node.getClientRects().length)return false;
      for(let current:Element|null=node;current;current=current.parentElement){const style=getComputedStyle(current);
        if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;}
      return true;
    },
    one(selector:string,root:Element|Document=document):Element{
      const nodes=root.querySelectorAll(selector);dom.check(nodes.length===1&&dom.visible(nodes[0]!));return nodes[0]!;
    },
    react(node:Element,prefix:string):unknown{
      const keys=Object.getOwnPropertyNames(node).filter(key=>key.startsWith(prefix));dom.check(keys.length===1);return dom.data(node,keys[0]!);
    },
    child(node:Element):unknown{
      const children=dom.data(dom.react(node,'__reactProps$'),'children');return dom.data(Array.isArray(children)?dom.data(children,'0'):children,'props');
    },
    work(raw:string):MessageShare|null{
      if(!raw||raw.length>2000)return null;
      try{const url=new URL(raw,location.href),match=/^\/(video|note)\/(\d{1,64})\/?$/u.exec(url.pathname);
        if(url.protocol!=='https:'||!['www.douyin.com','douyin.com'].includes(url.hostname)||url.username||url.password||url.port||!match)return null;
        return {kind:'DOUYIN_WORK',url:'https://www.douyin.com/'+match[1]+'/'+match[2],workId:match[2]!};
      }catch{return null;}
    },
    field(object:unknown,key:string):{shape:ShareFieldShape;value:unknown}{
      const shape:ShareFieldShape={key,type:'ABSENT',digitId:false,urlKind:'NOT_URL'};
      if(!object||typeof object!=='object')return {shape,value:undefined};
      const own=Object.getOwnPropertyDescriptor(object,key),inherited=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object)??{},key);
      if(own&&!Object.hasOwn(own,'value')||inherited&&!Object.hasOwn(inherited,'value'))return{shape:{...shape,type:'ACCESSOR'},value:undefined};
      if(own&&inherited&&own.value!==inherited.value)return{shape:{...shape,type:'CONFLICT'},value:undefined};
      const descriptor=own??inherited,value=descriptor?.value;
      shape.type=!descriptor||value===undefined?'ABSENT':value===null?'NULL':Array.isArray(value)?'ARRAY':
        typeof value==='string'?'STRING':typeof value==='number'?'NUMBER':typeof value==='boolean'?'BOOLEAN':typeof value==='object'?'OBJECT':'OTHER';
      shape.digitId=typeof value==='string'&&/^[1-9]\d{0,63}$/u.test(value);
      if(typeof value==='string'&&value.length<=2000){const work=dom.work(value);
        shape.urlKind=work?work.url.includes('/note/')?'DOUYIN_NOTE':'DOUYIN_VIDEO':/^(?:https?:|\/)/u.test(value)?'OTHER_URL':'NOT_URL';}
      return {shape,value};
    },
    related(parsed:unknown):ShareCalibration['related']{
      const root=dom.field(parsed,'related_share_video'),result:ShareCalibration['related']={type:root.shape.type,fields:[],truncated:false};
      if(root.shape.type!=='OBJECT')return result;
      const queue:{value:unknown;fields:ShareFieldShape[];level:number}[]=[{value:root.value,fields:result.fields,level:0}];let remaining=16;
      for(let index=0;index<queue.length&&index<17;index++){
        const item=queue[index]!,keys=Object.getOwnPropertyNames(item.value);if(keys.length>remaining)result.truncated=true;
        for(const key of keys){
          if(remaining===0){result.truncated=true;break;}if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key)){result.truncated=true;continue;}
          const field=dom.field(item.value,key);remaining--;item.fields.push(field.shape);
          if(field.shape.type==='OBJECT'){
            if(item.level===0&&remaining>0){field.shape.fields=[];queue.push({value:field.value,fields:field.shape.fields,level:1});}
            else result.truncated=true;
          }
        }
      }
      return result;
    },
    modernShare(parsed:unknown):ModernShareShape{
      const camel=dom.field(parsed,'itemId'),snake=dom.field(parsed,'item_id'),schema=dom.field(parsed,'schema'),info=dom.field(parsed,'aweme_info');
      const item=dom.field(info.value,'item_id'),awemeId=dom.field(info.value,'aweme_id'),awemeType=dom.field(info.value,'aweme_type'),type=dom.field(info.value,'type');
      const check={
        id(value:unknown):string|null{return typeof value==='string'&&/^[1-9]\d{0,63}$/u.test(value)?value:null;},
        equal(first:unknown,second:unknown):boolean|null{const a=check.id(first),b=check.id(second);return a&&b?a===b:null;},
        number(value:unknown):number|null{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=1000?value:null;},
      };
      let kind:ModernShareShape['schema']['kind']='INVALID',schemaId:string|null=null;
      if(typeof schema.value==='string'&&schema.value.length>0&&schema.value.length<=2048&&!/[\\\x00-\x20\x7f]/u.test(schema.value))try{
        const url=new URL(schema.value);kind='OTHER';
        if(url.username||url.password||url.port)kind='INVALID';
        else if(url.protocol==='aweme:'&&url.hostname==='aweme'){
          const match=/^\/detail\/([1-9]\d{0,63})\/?$/u.exec(url.pathname);if(match){kind='AWEME_DETAIL';schemaId=match[1]!;}
        }else if(url.protocol==='https:'&&['www.douyin.com','douyin.com'].includes(url.hostname)){
          const match=/^\/(video|note)\/([1-9]\d{0,63})\/?$/u.exec(url.pathname);if(match){kind=match[1]==='video'?'WEB_VIDEO':'WEB_NOTE';schemaId=match[2]!;}
        }
      }catch{/* Invalid or unsupported schema is measured, never opened or used as a share. */}
      const ids=[camel.value,snake.value,item.value,awemeId.value,schemaId].map(value=>check.id(value)).filter((value):value is string=>value!==null);
      return {snakeItem:snake.shape,schema:{type:schema.shape.type,kind,itemMatchesSnake:check.equal(schemaId,snake.value),
        itemMatchesCamel:check.equal(schemaId,camel.value),itemMatchesAwemeItem:check.equal(schemaId,item.value),itemMatchesAwemeId:check.equal(schemaId,awemeId.value)},
        awemeInfo:{type:info.shape.type,fields:[item.shape,awemeId.shape,awemeType.shape,type.shape],awemeType:check.number(awemeType.value),
          typeValue:check.number(type.value),itemMatchesSnake:check.equal(item.value,snake.value),awemeMatchesSnake:check.equal(awemeId.value,snake.value)},
        identityConflict:new Set(ids).size>1};
    },
    modernRoute(parsed:unknown,native:unknown,visible:MessageShare|null):{detected:boolean;share:MessageShare|null;conflict:boolean}{
      if(dom.field(native,'type').value!==110)return {detected:false,share:null,conflict:false};
      const info=dom.field(parsed,'aweme_info'),schema=dom.field(parsed,'schema'),measured=dom.modernShare(parsed);
      const fields=[dom.field(parsed,'itemId'),dom.field(parsed,'item_id'),dom.field(info.value,'item_id'),dom.field(info.value,'aweme_id')];
      const ids=fields.filter(field=>field.shape.digitId).map(field=>field.value as string),id=ids[0];
      const invalid=fields.some(field=>!['ABSENT','NULL'].includes(field.shape.type)&&!field.shape.digitId)||
        !['ABSENT','NULL','OBJECT'].includes(info.shape.type)||measured.identityConflict||!!visible&&ids.some(value=>value!==visible.workId);
      const types=[dom.field(parsed,'awemeType'),dom.field(info.value,'aweme_type')],slides=dom.field(parsed,'is_slides');
      const known=types.filter(field=>field.shape.type!=='ABSENT').map(field=>field.value),badType=known.some(value=>![0,55,68].includes(value as number));
      const typeRoutes=new Set<string>(known.map(value=>value===68?'note':'video'));
      const slideRoute=slides.shape.type==='ABSENT'||slides.value===false?null:slides.value===true?'note':'INVALID';
      if(slideRoute&&slideRoute!=='INVALID')typeRoutes.add(slideRoute);
      const invalidRoute=badType||slideRoute==='INVALID'||typeRoutes.size>1;
      let route=measured.schema.kind==='WEB_VIDEO'?'video':measured.schema.kind==='WEB_NOTE'?'note':null;
      if(route&&typeRoutes.size&& !typeRoutes.has(route))return {detected:true,share:null,conflict:true};
      if(!route&&measured.schema.kind==='AWEME_DETAIL'&&[0,55,68].includes(dom.field(info.value,'aweme_type').value as number)&&typeRoutes.size===1&&!badType)route=[...typeRoutes][0]!;
      if(invalid||invalidRoute)return {detected:true,share:null,conflict:true};
      if(!id||!route||schema.shape.type!=='STRING'||!['WEB_VIDEO','WEB_NOTE','AWEME_DETAIL'].includes(measured.schema.kind))return {detected:true,share:null,conflict:false};
      // The measured schema ID must agree with at least one exact fixed native ID; no title or nested URL is consumed.
      if(![measured.schema.itemMatchesCamel,measured.schema.itemMatchesSnake,measured.schema.itemMatchesAwemeItem,measured.schema.itemMatchesAwemeId].includes(true))
        return {detected:true,share:null,conflict:false};
      return {detected:true,share:{kind:'DOUYIN_WORK',url:'https://www.douyin.com/'+route+'/'+id,workId:id},conflict:false};
    },
    ownershipPath(node:Element,row:Element):OwnershipPath{
      const result:OwnershipPath={steps:[],reachedRow:false,truncated:false};let current:Element|null=node;
      for(let depth=0;current&&current!==row&&depth<6;depth++,current=current.parentElement){
        const tag=current.tagName,known=['DIV','SPAN','IMG','VIDEO','AUDIO','A','BUTTON','P','BR'].includes(tag),parent=current.parentElement;
        const bounded=!!parent&&parent.childElementCount<=250,index=bounded?Array.prototype.indexOf.call(parent.children,current):-1;
        result.steps.push({tag:known?tag as OwnershipPath['steps'][number]['tag']:'OTHER',childIndex:index>=0?index:null});
        if(!bounded)result.truncated=true;
      }
      result.reachedRow=current===row;result.truncated=result.truncated||!result.reachedRow;return result;
    },
    mediaShape(node:Element,text:Element|null,row:Element):MediaOwnershipShape{
      const result:MediaOwnershipShape={path:dom.ownershipPath(node,row),textRelation:'UNAVAILABLE',commonDepth:null,
        inRowRect:false,inTextRect:false,anchor:false,menu:false,dialog:false,ariaHidden:false,quote:false};
      const bounds=node.getBoundingClientRect(),rowBounds=row.getBoundingClientRect(),textBounds=text?.getBoundingClientRect();
      result.inRowRect=bounds.left>=rowBounds.left&&bounds.right<=rowBounds.right&&bounds.top>=rowBounds.top&&bounds.bottom<=rowBounds.bottom;
      result.inTextRect=!!textBounds&&bounds.left>=textBounds.left&&bounds.right<=textBounds.right&&bounds.top>=textBounds.top&&bounds.bottom<=textBounds.bottom;
      if(text){
        result.textRelation=text.contains(node)?'INSIDE':node.contains(text)?'CONTAINS':
          text.compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING?'AFTER':
            text.compareDocumentPosition(node)&Node.DOCUMENT_POSITION_PRECEDING?'BEFORE':'UNAVAILABLE';
        let common:Element|null=node;
        for(let depth=0;common&&depth<=6;depth++,common=common.parentElement){
          if(!common.contains(text))continue;
          let ancestor:Element|null=common;
          for(let rowDepth=0;ancestor&&rowDepth<=6;rowDepth++,ancestor=ancestor.parentElement)if(ancestor===row){result.commonDepth=rowDepth;break;}
          break;
        }
      }
      for(let current:Element|null=node,depth=0;current&&current!==row&&depth<6;depth++,current=current.parentElement){
        const role=Element.prototype.getAttribute.call(current,'role');
        result.anchor=result.anchor||current.tagName==='A'&&current.hasAttribute('href');
        result.menu=result.menu||role==='menu';result.dialog=result.dialog||role==='dialog'||current.tagName==='DIALOG';
        result.ariaHidden=result.ariaHidden||Element.prototype.getAttribute.call(current,'aria-hidden')==='true';
        result.quote=result.quote||current.matches('blockquote,q,[data-e2e="message-quote"],[data-e2e="message-reply-preview"],[class*="MessageItemReply"],[class*="MessageItemQuote"],[class*="QuoteMessage"]');
      }
      return result;
    },
    textCalibration(native:unknown,parsed:unknown,row:Element):ShareCalibration['text']{
      const texts=Array.from(row.querySelectorAll(s.messageText)).filter(node=>node.closest(s.messages)===row),visible=texts.filter(dom.visible),
        media=Array.from(row.querySelectorAll('img,video,audio')).filter(node=>node.closest(s.messages)===row&&dom.visible(node));
      const inline=media.filter(node=>node.tagName==='IMG'&&visible.some(text=>text.contains(node))),other=media.length-inline.length;
      const result={nativeType7:dom.field(native,'type').value===7,ownedTextCount:Math.min(250,texts.length),visibleTextCount:Math.min(250,visible.length),
        inlineImages:Math.min(250,inline.length),otherMedia:Math.min(250,other),reconstructed:false,matchesNative:false,bodyReconstructed:false,bodyNonEmpty:false,bodyMatchesNative:false,
        textPath:visible.length===1?dom.ownershipPath(visible[0]!,row):null,
        mediaShapes:media.slice(0,4).map(node=>dom.mediaShape(node,visible.length===1?visible[0]!:null,row)),mediaShapesTruncated:media.length>4};
      if(visible.length!==1)return result;
      let visited=0,images=0,length=0;
      const traversal={
        append(value:string):string|null{length+=value.length;return length<=10_000?value:null;},
        walk(node:Node):string|null{
          if(++visited>180)return null;if(node.nodeType===Node.TEXT_NODE)return traversal.append(node.nodeValue??'');
          if(!(node instanceof Element)||node.closest(s.messages)!==row||!['SPAN','DIV','P','B','I','EM','STRONG','A','BR','IMG'].includes(node.tagName))return null;
          const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return '';
          if(node.tagName==='BR')return traversal.append('\n');
          if(node.tagName==='IMG'){
            if(++images>8||node.childNodes.length||node.closest('a[href]'))return null;
            const alt=Element.prototype.getAttribute.call(node,'alt'),source=Element.prototype.getAttribute.call(node,'src');
            if(!alt||alt.length>32||/[\x00-\x1f\x7f]/u.test(alt)||
              !/(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u.test(alt)&&!/^\[[^\[\]\r\n]{1,20}\]$/u.test(alt)||!source)return null;
            try{const url=new URL(source,location.origin);if(url.username||url.password||url.protocol!=='https:'&&!(m.environment==='fixture'&&url.origin===location.origin))return null;}catch{return null;}
            return traversal.append(alt);
          }
          let value='';for(const child of node.childNodes){const part=traversal.walk(child);if(part===null)return null;value+=part;}return value;
        },
      };
      const text=traversal.walk(visible[0]!);result.bodyReconstructed=text!==null;result.bodyNonEmpty=text!==null&&text.trim().length>0;
      result.bodyMatchesNative=text!==null&&text===dom.field(parsed,'text').value;
      result.reconstructed=!other&&inline.length<=8&&result.bodyReconstructed;result.matchesNative=result.reconstructed&&result.bodyMatchesNative;
      return result;
    },
  };
  dom.check(event.channel==='DIRECT_MESSAGE'&&!!event.platformEventId&&!!event.conversationId&&!!event.actorId&&!!event.occurredAt&&
    location.origin===m.origin&&!/验证码|安全验证/u.test(document.title)&&!Array.from(document.querySelectorAll(m.securityBlockers)).some(dom.visible));
  let fiber=dom.react(dom.one(s.selfAvatar),'__reactFiber$');for(let index=0;index<s.selfFiberDepth;index++)fiber=dom.data(fiber,'return');
  const own=dom.data(fiber,'memoizedProps');dom.check(dom.data(own,'uid')===m.self.uid&&dom.data(own,'secUid')===m.self.secUid);
  const chat=dom.one(s.chat),conversation=dom.data(dom.child(dom.one(s.chatHeader,chat)),'conversation');
  const first=dom.data(conversation,'conversationId'),second=dom.data(conversation,'id');
  dom.check((first===undefined||second===undefined||first===second)&&(first??second)===event.conversationId&&event.conversationId===peer.conversationId&&
    dom.data(conversation,'_toParticipantSecUserId')===peer.secUid&&dom.one(s.chatTitle,chat).textContent?.trim()===peer.title);
  const rows=Array.from(chat.querySelectorAll(s.messages)).filter(row=>dom.data(dom.data(dom.child(row),'message'),'serverId')===event.platformEventId);
  dom.check(rows.length===1&&dom.visible(rows[0]!));const row=rows[0]!,native=dom.data(dom.child(row),'message');
  dom.check(dom.data(native,'conversationId')===event.conversationId&&dom.data(native,'sender')===event.actorId);
  const date=dom.data(native,'createdAt');let at=NaN;try{at=Date.prototype.getTime.call(date);}catch{/* Not a native date. */}
  dom.check(Number.isFinite(at)&&new Date(at).toISOString()===event.occurredAt);
  let fromMe=false;const box=row.closest(s.messageBox);dom.check(box);
  for(let node:Element|null=row;node&&box!.contains(node);node=node.parentElement)if(node.classList.contains(s.fromMeClass))fromMe=true;
  dom.check(fromMe===(event.direction==='OUTGOING')&&fromMe===(event.actorId===m.self.uid));
  const anchors=Array.from(row.querySelectorAll('a[href]')).filter(node=>node.closest(s.messages)===row&&dom.visible(node));
  dom.check(anchors.length<=20);
  const candidates=new Map<string,MessageShare>(),urlKinds:Record<string,number>={};
  for(const anchor of anchors){const share=dom.work(anchor.getAttribute('href')??'');if(share)candidates.set(share.url,share);}
  // These upstream card markers are diagnostic candidates, not proof of a work ID or its route.
  const cardMarkers=Array.from(row.querySelectorAll('[class*="MessageItemShareAwemecontainer"],[data-e2e="shared-video-card"]'))
    .filter(node=>node.closest(s.messages)===row&&dom.visible(node)).length;
  const parsed=dom.data(native,'_parsedContent'),fields:ShareInspection['diagnostic']['parsedFields']=[];
  const itemId=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?dom.data(parsed,'itemId'):undefined;
  const nativeItemId=typeof itemId==='string'&&/^\d{1,64}$/u.test(itemId)?itemId:null;
  const firstType=dom.data(parsed,'aweType'),secondType=dom.data(parsed,'awemeType'),slides=dom.data(parsed,'is_slides');
  const aweType=Number.isSafeInteger(firstType)&&Number(firstType)>=0&&Number(firstType)<=1000?Number(firstType):null;
  const awemeType=Number.isSafeInteger(secondType)&&Number(secondType)>=0&&Number(secondType)<=1000?Number(secondType):null;
  const nativeKinds={aweType,awemeType,isSlides:typeof slides==='boolean'?slides:null};
  const info=dom.data(parsed,'share_info'),shareInfo:ShareInspection['diagnostic']['shareInfo']=[];
  if(Array.isArray(info))for(let index=0;index<Math.min(3,info.length);index++){
    const value=dom.data(info,String(index)),fields:ShareInspection['diagnostic']['shareInfo'][number]['fields']=[];
    if(value&&typeof value==='object'&&!Array.isArray(value))for(const key of Object.getOwnPropertyNames(value).slice(0,16)){
      if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key))continue;const descriptor=Object.getOwnPropertyDescriptor(value,key)!,field=descriptor.value;
      const work=Object.hasOwn(descriptor,'value')&&typeof field==='string'?dom.work(field):null;
      fields.push({key,type:Object.hasOwn(descriptor,'value')?Array.isArray(field)?'array':field===null?'null':typeof field:'accessor',
        urlKind:work?work.url.includes('/note/')?'DOUYIN_NOTE':'DOUYIN_VIDEO':typeof field==='string'&&/^(?:https?:|\/)/u.test(field)?'OTHER_URL':'NOT_URL'});
    }
    shareInfo.push({type:Array.isArray(value)?'array':value===null?'null':typeof value,fields});
  }
  if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)){
    const descriptors=Object.getOwnPropertyDescriptors(parsed),keys=Object.keys(descriptors);dom.check(keys.length<=64);
    for(const key of keys.slice(0,32)){
      if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key))continue;const descriptor=descriptors[key]!,value=descriptor.value;
      const digitId=Object.hasOwn(descriptor,'value')&&typeof value==='string'&&/^\d{1,64}$/u.test(value);
      fields.push({key,type:Object.hasOwn(descriptor,'value')?Array.isArray(value)?'array':value===null?'null':typeof value:'accessor',digitId});
      if(Object.hasOwn(descriptor,'value')&&typeof value==='string'&&value.length<=2000){
        const work=dom.work(value),kind=work?'DOUYIN_WORK':/^(?:https?:|\/)/u.test(value)?'OTHER_URL':'NOT_URL';urlKinds[kind]=(urlKinds[kind]??0)+1;
      }
    }
  }
  let candidate=candidates.size===1?[...candidates.values()][0]!:null;
  // F2 f6be8c0 (Apache-2.0), douyin/dl.py:22-38 records 0/55 as video; this does not require is_slides to be present.
  // Keep the explicit slideshow route and invalid metadata distinct. aweType remains a separate IM field.
  const invalidSlides=slides!==undefined&&typeof slides!=='boolean';
  const route=!invalidSlides&&(slides===true||awemeType===68)?'note':!invalidSlides&&(awemeType===0||awemeType===55)?'video':null;
  const nativeShare=dom.data(native,'type')===8&&!!nativeItemId&&/^[1-9]\d{0,63}$/u.test(nativeItemId)&&
    typeof event.platformEventId==='string'&&/^[1-9]\d{0,63}$/u.test(event.platformEventId)&&(secondType===undefined||awemeType!==null)&&!!route;
  if(candidates.size===0&&(cardMarkers===1||nativeShare)&&nativeItemId&&route)candidate={kind:'DOUYIN_WORK',url:'https://www.douyin.com/'+route+'/'+nativeItemId,workId:nativeItemId};
  const modern=dom.modernRoute(parsed,native,candidate);
  const nativeItemIdConflict=!!nativeItemId&&!!candidate&&nativeItemId!==candidate.workId||modern.conflict||modern.detected&&candidates.size>1||!!modern.share&&!!candidate&&modern.share.url!==candidate.url;
  if(!candidate&&modern.share)candidate=modern.share;
  let calibration:ShareCalibration|undefined;
  try{
    const kind=dom.field(native,'type').value;
    calibration={nativeMessageKind:typeof kind==='number'&&Number.isSafeInteger(kind)&&kind>=0&&kind<=65535?kind:null,
      nativeRoute:route==='video'?'VIDEO':route==='note'?'NOTE':'UNAVAILABLE',
      routeReason:nativeItemIdConflict?'ITEM_CONFLICT':candidate?'LINKED':candidates.size>1?'MULTIPLE_LINKS':!nativeItemId?'MISSING_ITEM_ID':
        invalidSlides?'INVALID_SLIDES':!route?'UNKNOWN_ROUTE':'NO_CARD_OR_NATIVE_SHARE',
      parsedScalars:['text','itemId','aweType','awemeType','is_slides','related_share_video'].map(key=>dom.field(parsed,key).shape),
      related:dom.related(parsed),text:dom.textCalibration(native,parsed,row),modernShare:dom.modernShare(parsed)};
  }catch{/* Shape diagnostics cannot change an exact message's existing share decision. */}
  const nativeText=dom.field(parsed,'text'),nativeValue=nativeText.value;
  const nativeUsable=nativeText.shape.type==='STRING'&&typeof nativeValue==='string'&&nativeValue.length<=10_000&&nativeValue.trim().length>0&&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(nativeValue);
  const measured=calibration?.text;
  const display=calibration?.nativeMessageKind===7&&measured?.bodyReconstructed&&measured.bodyNonEmpty&&nativeUsable?
    {displayText:measured.bodyMatchesNative?nativeValue as string:null}:{};
  return {share:nativeItemIdConflict?null:candidate,detected:cardMarkers>0||candidates.size>0||nativeShare||modern.detected,...display,
    diagnostic:{anchors:anchors.length,cardMarkers,nativeItemIdPresent:!!nativeItemId,nativeItemIdConflict,nativeKinds,shareInfo,urlKinds,parsedFields:fields,...(calibration?{calibration}:{})}};
}
