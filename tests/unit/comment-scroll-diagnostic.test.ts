import {afterEach,expect,test,vi} from 'vitest';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {observedMapping} from '../fixtures/observed-site.js';

afterEach(()=>vi.unstubAllGlobals());
function fixture(length=9,scrollDepth=6){
  let writes=0,human=false;
  const nodes=Array.from({length},(_,depth)=>({tagName:depth===length-1?'BODY':'DIV',isConnected:true,parentElement:null as unknown,
    clientHeight:depth===scrollDepth?240:800,scrollHeight:depth===scrollDepth?1600:800,_top:depth===scrollDepth?120:0,
    style:{display:'block',visibility:'visible',opacity:'1',overflowY:depth===scrollDepth?'auto':'visible'},
    get scrollTop(){return this._top;},set scrollTop(value:number){writes++;this._top=value;},
    getClientRects(){return [{}];},getBoundingClientRect(){return {top:0,left:0,right:800,bottom:800,width:800,height:800};},
    querySelectorAll(){return [] as unknown[];},querySelector(){return null;},matches(){return false;},contains(node:unknown){return nodes.indexOf(node as typeof nodes[number])<=depth;}}));
  nodes.forEach((node,index)=>node.parentElement=nodes[index+1]??null);
  const avatar={...nodes[0],__reactFiber$fixture:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}};
  const documentNode={...nodes.at(-1)!,tagName:'HTML',parentElement:null,scrollHeight:800,clientHeight:800};
  class Input {}
  class Textarea {value='keep unsent synthetic draft';}
  const editor=Object.assign(new Textarea(),nodes[0]);
  const mapping=observedMapping('https://www.douyin.com');
  vi.stubGlobal('HTMLInputElement',Input);vi.stubGlobal('HTMLTextAreaElement',Textarea);
  vi.stubGlobal('location',{origin:mapping.origin,href:mapping.works[0]!.url});vi.stubGlobal('innerHeight',800);vi.stubGlobal('innerWidth',800);
  vi.stubGlobal('document',{title:'Synthetic',scrollingElement:documentNode,querySelectorAll(selector:string){
    return selector===mapping.selectors.selfAvatar?[avatar]:selector===mapping.selectors.commentList?[nodes[0]]:
      human&&selector==='[contenteditable="true"],textarea,input'?[editor]:[];}});
  vi.stubGlobal('getComputedStyle',(node:typeof nodes[number])=>node.style);
  const capture=()=>captureObserved({mapping,channel:'diagnostic',diagnosticSource:'comments',index:0,evidenceId:'synthetic-scroll-shape'});
  return{nodes,avatar,editor,documentNode,capture,writes:()=>writes,human:()=>{human=true;},
    scroll:(offset?:number)=>captureObserved({mapping,channel:'commentScroll',index:0,evidenceId:'synthetic-scroll-action',...(offset===undefined?{}:{commentOffset:offset})})};
}

test('diagnostic identifies a deeper actual scroll candidate using the same bounded contract as collection',()=>{
  const f=fixture(),value=f.capture().diagnostic!;
  expect(value.commentScroll).toMatchObject({selectedDepth:6,documentFallback:false,truncated:false,
    document:{tag:'HTML',clientHeight:800,scrollHeight:800,scrollTop:0}});
  expect(value.commentScroll?.ancestors).toHaveLength(9);
  expect(value.commentScroll?.ancestors[6]).toEqual({depth:6,tag:'DIV',overflowY:'auto',clientHeight:240,scrollHeight:1600,scrollTop:120,visible:true,containsList:true});
  expect(f.writes()).toBe(0);expect(JSON.stringify(value.commentScroll)).not.toMatch(/self-sec|douyin|fixture-scroll|"class":|"body":|href|url/i);
});

test('ancestor selection evidence keeps the nearest scope and bounds every report',()=>{
  const f=fixture(25,3),value=f.capture().diagnostic!.commentScroll!;
  expect(value.ancestors).toHaveLength(17);expect(value.truncated).toBe(true);expect(value.selectedDepth).toBe(3);expect(value.documentFallback).toBe(false);
  f.nodes[0]!.style.overflowY='PRIVATE-UNSUPPORTED-STYLE';f.nodes[0]!.scrollHeight=Number.MAX_SAFE_INTEGER;
  expect(f.capture().diagnostic?.commentScroll?.ancestors[0]).toMatchObject({overflowY:'OTHER',scrollHeight:10_000_000});
  expect(f.writes()).toBe(0);
});

test('a real depth-seven comment scroller advances and restores without moving the document',()=>{
  const f=fixture(15,7),before=f.documentNode.scrollTop;
  expect(f.scroll().scroll).toEqual({top:312,height:1600,viewport:240,atEnd:false});
  expect(f.nodes[7]!.scrollTop).toBe(312);expect(f.documentNode.scrollTop).toBe(before);
  expect(f.scroll(760).scroll?.top).toBe(760);expect(f.nodes[7]!.scrollTop).toBe(760);
  expect(f.capture().diagnostic?.commentScroll).toMatchObject({selectedDepth:7,documentFallback:false});
});

test('pagination diagnostics expose fixed visible controls without message bodies or scrolling',()=>{
  const f=fixture(),control=(textContent:string,insideRow=false)=>({...f.nodes[0],tagName:'BUTTON',textContent,childElementCount:0,closest:()=>insideRow?f.nodes[0]:null});
  f.nodes[4]!.querySelectorAll=()=>[control('查看更多评论'),control('暂时没有更多评论'),control('private synthetic message'),control('加载更多',true)];
  const report=f.capture().diagnostic!.commentPagination!;
  expect(report).toMatchObject({scanned:4,truncated:false,samples:[{kind:'MORE_COMMENTS',tag:'BUTTON',visible:true,inViewport:true},{kind:'NO_MORE'}]});
  expect(report.samples).toHaveLength(2);expect(JSON.stringify(report)).not.toContain('private synthetic message');expect(f.writes()).toBe(0);
});

test('only the nearest scrollable list ancestor is selected when multiple parents can scroll',()=>{
  const f=fixture(15,7);f.nodes[3]!.style.overflowY='scroll';f.nodes[3]!.clientHeight=200;f.nodes[3]!.scrollHeight=1200;
  expect(f.scroll().scroll?.top).toBe(160);expect(f.nodes[7]!.scrollTop).toBe(120);expect(f.documentNode.scrollTop).toBe(0);
});

test('a scroll candidate beyond the bounded search retains the document fallback',()=>{
  const f=fixture(25,20);expect(f.scroll().scroll).toEqual({top:0,height:800,viewport:800,atEnd:true});
  expect(f.nodes[20]!.scrollTop).toBe(120);expect(f.capture().diagnostic?.commentScroll).toMatchObject({selectedDepth:null,documentFallback:true,truncated:true});
});

test.each(['WORK','ACCOUNT','HUMAN'] as const)('depth-seven scrolling preserves the %s guard with zero movement',fault=>{
  const f=fixture(15,7);
  if(fault==='WORK')vi.stubGlobal('location',{origin:'https://www.douyin.com',href:'https://www.douyin.com/video/20'});
  if(fault==='ACCOUNT')f.avatar.__reactFiber$fixture.return.memoizedProps.uid='outside';
  if(fault==='HUMAN')f.human();
  expect(()=>f.scroll()).toThrow(fault==='WORK'?'OBSERVATION_WORK_CHANGED':fault==='ACCOUNT'?'OBSERVATION_ACCOUNT_CHANGED':'OBSERVATION_EXISTING_HUMAN_INPUT');
  expect(f.writes()).toBe(0);expect(f.nodes[7]!.scrollTop).toBe(120);expect(f.documentNode.scrollTop).toBe(0);
});
