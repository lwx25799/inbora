import {expect,test,vi,beforeEach} from 'vitest';
import {createElement,type ReactElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Status} from '../../desktop/src/api.js';
import {defaultSettings} from '../../src/app/contracts.js';
import {request} from '../../desktop/src/api.js';

vi.mock('../../desktop/src/api.js',()=>({request:vi.fn(),reasons:{ASSISTANT_CONNECTION_DISABLED:'助手连接已停用'}}));
const now=Date.parse('2026-11-11T04:00:00Z');

function fixture():Status {
  return {
    runtime:'D:\\Inbora\\.local\\synthetic-runtime',account:{id:'account_001',identity:'own-synthetic'},
    operator:{id:'fixture',permissions:['READ','EDIT'],expiresAt:now+60_000},
    mode:'MANUAL',configuredMode:'MANUAL',paused:false,browser:{state:'CLOSED',mode:'headless',version:null},
    lastSync:[],capabilities:[],budgets:[{kind:'MODEL',used:13,maximum:null},{kind:'SEND',used:21,maximum:30}],
    usage:{requests:13,inputTokens:0,outputTokens:0,unresolved:0},settings:defaultSettings,keyPresent:true,
    modelAuthorized:false,modelBusy:false,sync:{runId:null,running:false,cancelled:false,source:null,results:[]},
    go:'UNVERIFIED',schema:3,
    localAssistant:{connectionEnabled:true,grant:null,used:{MODEL:2,SEND:1},remaining:{MODEL:null,SEND:null},reason:null},
    localAssistantConnection:{ready:true,instanceId:'073dd6d8-95db-4381-b860-81a195c71fff',transport:'stdio',tools:16},
  };
}

function props(status=fixture()) {
  return {status,busy:'',act:async(_label:string,action:()=>Promise<void>)=>action(),update:vi.fn()};
}
const componentPath='../../desktop/src/LocalAssistantSettings.tsx';
const {LocalAssistantSettings}=await import(componentPath) as {LocalAssistantSettings:(value:ReturnType<typeof props>)=>ReactElement};
const html=(status=fixture(),busy='')=>renderToStaticMarkup(createElement(LocalAssistantSettings,{...props(status),busy}));

function button(node:ReactNode):ReactElement<{onClick:()=>void}>|undefined {
  if(!node||typeof node!=='object'||!('props' in node))return undefined;
  const element=node as ReactElement<{children?:ReactNode}>;
  if(element.type==='button')return element as ReactElement<{onClick:()=>void}>;
  const children=Array.isArray(element.props.children)?element.props.children:[element.props.children];
  for(const child of children){const result=button(child);if(result)return result;}
  return undefined;
}
beforeEach(()=>vi.mocked(request).mockReset());

test('the MCP region is enabled by default and exposes no per-assistant permission, expiry or quota form',()=>{
  const rendered=html();
  expect(rendered).toContain('本机助手连接（MCP）');
  expect(rendered).toContain('助手连接：已启用');
  expect(rendered).toContain('连接后即可查询收件箱、同步、编辑草稿和发送文字回复');
  expect(rendered).toContain('停用助手连接');
  expect(rendered).not.toContain('<input');
  expect(rendered).not.toContain('保存并启用');
  expect(rendered).not.toContain('授权到期时间');
  expect(rendered).toContain('应用累计：模型 13/无上限 · 发送 21/30');
  expect(rendered).toContain('沿用当前账号、已保存收取范围、应用累计额度与模型许可');
});

test('status reflects the exact runtime and backend instance without claiming a Codex invocation',()=>{
  const status=fixture(),rendered=html(status);
  expect(rendered).toContain(status.runtime);
  expect(rendered).toContain(status.localAssistantConnection!.instanceId);
  expect(rendered).toContain('本机控制入口：已就绪');
  expect(rendered).toContain('stdio · 16 个工具');
  expect(rendered).toContain('安装与实际工具调用需单独核验');
  delete status.localAssistantConnection;
  expect(html(status)).toContain('本机控制入口：尚未就绪');
  expect(html(status)).toContain('尚未建立');
});

test.each([true,false])('the single toggle changes connectionEnabled=%s without accepting caller scope',async enabled=>{
  const status=fixture();status.localAssistant!.connectionEnabled=enabled;
  const next=fixture();next.localAssistant!.connectionEnabled=!enabled;
  vi.mocked(request).mockResolvedValue(next);
  const input=props(status);
  button(LocalAssistantSettings(input))!.props.onClick();
  await vi.waitFor(()=>expect(input.update).toHaveBeenCalledWith(next));
  expect(request).toHaveBeenCalledExactlyOnceWith({command:'setLocalAssistantGrant',enabled:!enabled,confirmed:true});
  expect(status.budgets).toEqual(fixture().budgets);
});

test('a stopped connection offers only re-enable and preserves the existing application usage',()=>{
  const status=fixture();status.localAssistant!.connectionEnabled=false;status.localAssistant!.reason='ASSISTANT_CONNECTION_DISABLED';
  const rendered=html(status);
  expect(rendered).toContain('助手连接：已停用');
  expect(rendered).toContain('启用助手连接');
  expect(rendered).not.toContain('>停用助手连接<');
  expect(rendered).toContain('模型 13/无上限 · 发送 21/30');
  expect(rendered).toContain('不撤回、不重发');
  expect(rendered).toContain('消息、草稿和已消费额度保留');
});

test('busy and unavailable backend states cannot submit a connection toggle',()=>{
  expect(html(fixture(),'saving')).toMatch(/<button disabled="">停用助手连接<\/button>/u);
  const status=fixture();delete status.localAssistant;
  expect(html(status)).toMatch(/<button disabled="">停用助手连接<\/button>/u);
});