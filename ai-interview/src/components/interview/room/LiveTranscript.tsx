import type { InterviewAnswer } from '../../../types/interview'

export function LiveTranscript({answers,draft,interim}:{answers:InterviewAnswer[];draft:string;interim:string}) {
  const recent=answers.slice(-3)
  return <section className="room-transcript"><div className="room-section-title"><h3>当前回答</h3><span>{interim?'正在识别':'语音转写 / 文字输入'}</span></div><div className="room-transcript__live" aria-live="polite">{draft||interim ? <>{draft}{interim&&<span className="room-interim"> {interim}</span>}</> : <span className="room-transcript__empty">可用麦克风转写，也可以直接在下方文字框输入。</span>}</div>{recent.length>0&&<div className="room-transcript__history"><span>最近回答 · AI 复盘</span>{recent.map((answer,index)=><div className="room-transcript__item" key={answer.questionId+'-'+index}><p>{answer.answer||'已跳过这道题'}</p>{answer.aiSummary&&<small><b>{answer.aiSummarySource==='deepseek'?'DeepSeek 总结':'本地总结'}</b>{answer.aiSummary}</small>}{answer.reaction&&answer.reaction.source!=='unavailable'&&<small className="room-transcript__reaction"><b>{answer.reaction.source==='facephys'?'FacePhys 状态':'演示状态'}</b>{answer.reaction.label}</small>}</div>)}</div>}</section>
}
