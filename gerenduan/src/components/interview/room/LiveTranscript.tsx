import type { InterviewAnswer } from '../../../types/interview'

export function LiveTranscript({answers,draft,interim}:{answers:InterviewAnswer[];draft:string;interim:string}) {
  const recent=answers.slice(-3)
  return <section className="room-transcript"><div className="room-section-title"><h3>当前回答</h3><span>{interim?'正在识别':'语音转写 / 文字输入'}</span></div><div className="room-transcript__live" aria-live="polite">{draft||interim ? <>{draft}{interim&&<span className="room-interim"> {interim}</span>}</> : <span className="room-transcript__empty">可用麦克风转写，也可以直接在下方文字框输入。</span>}</div>{recent.length>0&&<div className="room-transcript__history"><span>最近回答</span>{recent.map((answer,index)=><p key={answer.questionId+'-'+index}>{answer.answer||'已跳过这道题'}</p>)}</div>}</section>
}
