import type {Status} from './api';

export function SecurityRuntimeDetails({status}:{status:Status}) {
  const runtime=status.securityRuntime;
  const mismatch=runtime?.instanceId&&status.localAssistantConnection?.instanceId&&
    runtime.instanceId!==status.localAssistantConnection.instanceId;
  return <details className="settings-disclosure"><summary>安全检查运行版本</summary>
    <dl>
      <div><dt>后端实例</dt><dd><code>{runtime?.instanceId??'尚未取得'}</code></dd></div>
      <div><dt>检测规则版本</dt><dd><code>{runtime?.ruleVersion??'尚未取得'}</code></dd></div>
      <div><dt>已加载规则指纹</dt><dd><code style={{overflowWrap:'anywhere'}}>{runtime?.fingerprint??'尚未取得'}</code></dd></div>
    </dl>
    {mismatch&&<p className="error">规则记录与当前连接实例不一致，不能据此确认修复已生效。</p>}
    <p className="hint">以上信息来自当前连接后端已加载的规则。未取得指纹时，不能据此确认修复已生效。</p>
  </details>;
}
