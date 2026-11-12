import {expect,test} from 'vitest';
import {createElement,type ComponentType} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Status} from '../../desktop/src/api.js';

function props(reason:string,legacy=false){
  return {status:{browser:{mode:'headless',loginRecovery:false},automation:{emergencyStopped:true,
    emergencyStop:{reason,source:'COLLECTION_COMMENTS',stoppedAt:legacy?null:1794399998894,legacy}}} as Status,
    busy:'',act:async(_label:string,run:()=>Promise<void>)=>run(),update:()=>{}};
}
const componentPath='../../desktop/src/EmergencyStopNotice.tsx';
const {EmergencyStopNotice}=await import(componentPath) as {EmergencyStopNotice:ComponentType<ReturnType<typeof props>>};
const render=(value:ReturnType<typeof props>)=>renderToStaticMarkup(createElement(EmergencyStopNotice,value));

test('a fresh security incident explains its observed signal and offers direct recovery without assuming the current account is broken',()=>{
  const html=render(props('OBSERVATION_SECURITY_COMPONENT'));
  expect(html).toContain('页面出现已识别的安全验证组件');expect(html).toContain('触发来源：评论后台收取');
  expect(html).toContain('网页账号正常时可直接检查恢复');expect(html).toContain('>检查并恢复运行</button>');
  expect(html).toContain('>处理登录或验证</button>');expect(html).not.toContain('旧版本未独立记录');
});

test('legacy errors are only diagnostic hints and do not become invented incident timestamps or definite causes',()=>{
  const html=render(props('OBSERVATION_PAGE_BLOCKED',true));
  expect(html).toContain('旧版本未记录急停时间');expect(html).toContain('旧版本未独立记录本次急停原因');
  expect(html).toContain('最近收取错误（供排查）');expect(html).toContain('排查来源：评论后台收取');
  expect(html).not.toContain('2026');
});

test('running accounts have no emergency notice and visible recovery preserves the stopped state until an explicit check',()=>{
  const value=props('OBSERVATION_SECURITY_COMPONENT');value.status.automation!.emergencyStopped=false;
  expect(render(value)).toBe('');value.status.automation!.emergencyStopped=true;
  value.status.browser.mode='headed';value.status.browser.loginRecovery=true;value.busy='检查并恢复运行';
  const html=render(value);expect(html).toContain('>返回无头并检查恢复</button>');expect(html).toContain('disabled=""');
  expect(html).not.toContain('>处理登录或验证</button>');
});
