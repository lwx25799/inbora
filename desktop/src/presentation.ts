export function time(value: string | number | null | undefined) {
  return value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "尚无成功记录";
}
export const modes = {
  OBSERVE: "只读观察",
  DRAFT_ONLY: "仅保存草稿",
  MANUAL: "纯人工回复",
  AI_ASSISTED: "AI 辅助回复",
  LIMITED_AUTO: "规则自动回复",
};
export function browserState(state:string,stopped=false){
  if(state==='CLOSED')return stopped?'已关闭（已急停）':'正在自动连接';
  if(state==='STARTING')return '正在启动';
  if(state==='OPEN_LAST_READ_VERIFIED')return '已连接';
  if(state==='OPEN_IDENTITY_UNVERIFIED')return '已打开';
  if(state==='BROWSER_START_FAILED')return '启动未完成，后台重试中';
  return '正在更新连接状态';
}
