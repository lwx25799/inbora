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
