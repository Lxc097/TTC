import type { InterviewAnswer, QuestionReaction } from '../../../types/interview'
import { CurrentQuestion } from './CurrentQuestion'
import { LiveTranscript } from './LiveTranscript'
import { DeviceStatus } from './DeviceStatus'

interface InterviewSidebarProps {
  number:number
  total:number
  prompt:string
  isFollowUp:boolean
  answers:InterviewAnswer[]
  draft:string
  interim:string
  cameraStatus:string
  micStatus:string
  micLevel:number
  notice?:string
  reaction: QuestionReaction
  showBiometrics?: boolean
}

export function InterviewSidebar(props:InterviewSidebarProps) {
  return <aside className="room-sidebar"><CurrentQuestion number={props.number} total={props.total} prompt={props.prompt} isFollowUp={props.isFollowUp}/>{props.showBiometrics !== false && <section className="room-reaction" aria-live="polite"><div className="room-section-title"><h3>本题状态提示</h3><span>{props.reaction.source === 'facephys' ? 'FacePhys' : props.reaction.source === 'mock' ? '演示数据' : '等待采样'}</span></div><strong>{props.reaction.label}</strong><p>{props.reaction.detail}</p></section>}<LiveTranscript answers={props.answers} draft={props.draft} interim={props.interim}/><DeviceStatus cameraStatus={props.cameraStatus} micStatus={props.micStatus} micLevel={props.micLevel} notice={props.notice}/></aside>
}
