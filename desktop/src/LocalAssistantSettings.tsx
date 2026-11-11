import {request,reasons,type Status} from './api';

interface Props {
  status:Status;
  busy:string;
  act:(label:string,action:()=>Promise<void>)=>Promise<void>;
  update:(status:Status)=>void;
}

export function LocalAssistantSettings({status,busy,act,update}:Props) {
  const state=status.localAssistant;
  const connection=status.localAssistantConnection;
  const enabled=state?.connectionEnabled!==false;
  return <div className="settings-section" aria-labelledby="local-assistant-title">
    <h2 id="local-assistant-title">本机助手连接（MCP）</h2>
    <p role="status">助手连接：{enabled?'已启用':'已停用'} · 本机控制入口：{connection?.ready?'已就绪':'尚未就绪'}</p>
    <p>本机助手连接后即可查询收件箱、同步、编辑草稿和发送文字回复，无需另设助手权限或额度。</p>
    <p className="hint">沿用当前账号、已保存收取范围、应用累计额度与模型许可；生成 AI 建议仍需可用的模型 Key。</p>
    <p className="hint">仅支持正文完整且已核验的文字消息。人工编辑中的回复、人稿及现有发送记录保留。</p>
    {state?.reason&&!(enabled&&!state.grant&&state.reason==='ASSISTANT_PERMISSION_REQUIRED')&&
      <p className="hint">{reasons[state.reason]??'助手暂不可执行当前操作，请核对应用运行状态。'}</p>}
    <p className="hint">应用累计：{status.budgets.map(budget=>`${budget.kind==='MODEL'?'模型':'发送'} ${budget.used}/${budget.maximum===null?'无上限':budget.maximum}`).join(' · ')||'尚未取得额度'}</p>
    <button disabled={!!busy||!state} onClick={()=>void act(enabled?'停用助手连接':'启用助手连接',async()=>update(await request<Status>({
      command:'setLocalAssistantGrant',enabled:!enabled,confirmed:true,
    })))}>{enabled?'停用助手连接':'启用助手连接'}</button>
    <p className="hint">停用立即阻止新的助手操作。已提交消息继续只读确认，不撤回、不重发；消息、草稿和已消费额度保留。</p>
    <details className="settings-disclosure"><summary>MCP 连接详情 · {connection?.tools??16} 个工具</summary>
      <dl>
        <div><dt>当前运行目录</dt><dd><code>{status.runtime}</code></dd></div>
        <div><dt>后端实例</dt><dd><code>{connection?.instanceId??'尚未建立'}</code></dd></div>
        <div><dt>连接方式</dt><dd>stdio · {connection?.tools??16} 个工具</dd></div>
      </dl>
      <p className="hint">入口就绪仅表示客户端可供连接。Codex 中的安装与实际工具调用需单独核验。</p>
    </details>
  </div>;
}
