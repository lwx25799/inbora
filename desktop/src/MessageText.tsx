/** Display-only text; callers keep the original string for drafts, bindings and sending. */
export function MessageText({text}:{text:string}){
  // UniEmoji 57568e94124772d5a4802f3e42d9c93c1fc5690d: emoji.json and docs/archive/EMOJI_KEYS.md.
  // These are Unicode display equivalents; no platform image or source text is replaced.
  return <span className="message-text">{text.split(/(\[赞\]|\[微笑\])/u).map((part,index)=>{
    const emoji=part==='[赞]'?'👍':part==='[微笑]'?'🙂':null;
    return emoji?<span key={index} role="img" aria-label={part} title={part}>{emoji}</span>:part;
  })}</span>;
}
