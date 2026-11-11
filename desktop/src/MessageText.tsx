// Names checked against UniEmoji 57568e94124772d5a4802f3e42d9c93c1fc5690d emoji.json.
// Unicode equivalents are display-only; platform-specific expressions without a clear equivalent stay as text.
const emojiLabels:Readonly<Record<string,string>>={
  '[赞]':'👍','[点赞]':'👍','[强]':'👍','[真棒]':'👍','[微笑]':'🙂','[呲牙]':'😁',
  '[大笑]':'😆','[笑哭]':'😂','[偷笑]':'🤭','[调皮]':'😜','[吐舌]':'😛','[捂脸]':'🤦',
  '[流泪]':'😢','[大哭]':'😭','[泣不成声]':'😭','[困]':'😴','[思考]':'🤔','[疑惑]':'😕',
  '[害羞]':'😳','[星星眼]':'🤩','[惊恐]':'😱','[翻白眼]':'🙄','[白眼]':'🙄','[闭嘴]':'🤐',
  '[嘘]':'🤫','[发怒]':'😡','[生气]':'😠','[可怜]':'🥺','[难过]':'😞','[哈欠]':'🥱',
  '[爱心]':'❤️','[心碎]':'💔','[比心]':'❤️','[爱心手]':'❤️','[鼓掌]':'👏','[双手合十]':'🙏',
  '[祈祷]':'🙏','[加油]':'💪','[强壮]':'💪','[握手]':'🤝','[比耶]':'✌️','[耶]':'✌️',
  '[OK]':'👌','[再见]':'👋','[拜拜]':'👋','[摊手]':'🤷','[飞吻]':'😘','[鞠躬]':'🙇',
  '[玫瑰]':'🌹','[凋谢]':'🥀','[干杯]':'🍻','[啤酒]':'🍺','[咖啡]':'☕','[蛋糕]':'🎂',
  '[礼物]':'🎁','[庆祝]':'🎉','[撒花]':'🎉','[太阳]':'☀️','[月亮]':'🌙','[西瓜]':'🍉',
  '[气球]':'🎈','[烟花]':'🎆','[雪花]':'❄️','[圣诞树]':'🎄','[红包]':'🧧','[灯笼]':'🏮',
};

/** Display-only text; callers keep the original string for drafts, bindings and sending. */
export function MessageText({text}:{text:string}){
  return <span className="message-text">{text.split(/(\[[^\[\]\r\n]{1,20}\])/u).map((part,index)=>{
    const emoji=Object.hasOwn(emojiLabels,part)?emojiLabels[part]:null;
    return emoji?<span key={index} role="img" aria-label={part} title={part}>{emoji}</span>:part;
  })}</span>;
}
