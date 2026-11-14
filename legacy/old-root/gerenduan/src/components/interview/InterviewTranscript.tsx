import { AudioLines, UserRound } from 'lucide-react'
import type { InterviewAnswer } from '../../types/interview'

export function InterviewTranscript({answers,currentPrompt}:{answers:InterviewAnswer[];currentPrompt:string}) {
  return <div className="transcript-list" aria-live="polite">{answers.map((item,index)=><div className="transcript-pair" key={index}><div className="transcript-message ai"><span><AudioLines size={15}/></span><p>{item.prompt}</p></div><div className="transcript-message user"><span><UserRound size={15}/></span><p>{item.answer||'已跳过这道题'}</p></div></div>)}<div className="transcript-message ai current"><span><AudioLines size={15}/></span><p>{currentPrompt}</p></div></div>
}
