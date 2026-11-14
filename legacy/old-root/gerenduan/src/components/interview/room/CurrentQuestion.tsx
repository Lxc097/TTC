export function CurrentQuestion({number,total,prompt,isFollowUp}:{number:number;total:number;prompt:string;isFollowUp:boolean}) {
  return <section className="room-question"><div className="room-question__meta"><span>{isFollowUp?'延伸追问':'当前问题'}</span><strong>{String(number).padStart(2,'0')} <span>/ {String(total).padStart(2,'0')}</span></strong></div><h2>{prompt}</h2></section>
}
