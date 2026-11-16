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
  expect(html).toContain('候选安全组件');expect(html).toContain('缺少足以确认验证生效的现场证明');expect(html).toContain('触发来源：评论后台收取');
  expect(html).toContain('在客户端内处理原无头页面');expect(html).toContain('若原页面已关闭或变化');expect(html).toContain('>检查并恢复运行</button>');
  expect(html).not.toContain('>处理登录或验证</button>');expect(html).not.toContain('旧版本未独立记录');
});

test('unresolved candidates offer the original headless page without claiming a captcha or a global stop',()=>{
  const value=props('OBSERVATION_SECURITY_SUSPECT');value.status.automation!.emergencyStopped=false;
  value.status.securityHolds=[{channel:'COMMENT_NOTIFICATION',reason:'OBSERVATION_SECURITY_SUSPECT',incidentId:'synthetic-incident',
    revision:'synthetic-revision',heldAt:1794399998894,mode:'headless'}];
  const html=render(value);
  expect(html).toContain('页面安全状态待核验');expect(html).toContain('评论通道');
  expect(html).toContain('synthetic-incident');expect(html).toContain('已有草稿可继续保存');
  expect(html).not.toContain('全局急停，等待恢复');expect(html).toContain('处理原验证页面</button>');
  expect(html).toContain('>检查并恢复运行</button>');expect(html).toContain('原现场证据仍单独保留');
  expect(html).not.toContain('已触发验证码');
  value.status.browser.mode='headed';value.status.browser.loginRecovery=true;value.busy='检查并恢复运行';
  const headed=render(value);expect(headed).toContain('>返回无头并检查恢复</button>');
  expect(headed).toContain('disabled=""');expect(headed).not.toContain('>处理原验证页面</button>');
});

test('only a concrete login requirement offers the separate headed login flow',()=>{
  expect(render(props('LOGIN_REQUIRED'))).toContain('>处理登录</button>');
  expect(render(props('CHALLENGE_REQUIRED'))).not.toContain('>处理登录</button>');
});

test('a title-only historical signal is reported as insufficient evidence',()=>{
  const html=render(props('OBSERVATION_SECURITY_TITLE'));
  expect(html).toContain('仅命中了页面标题');expect(html).toContain('尚不能确认发生了安全验证');
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
