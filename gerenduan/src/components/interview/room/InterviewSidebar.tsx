import type { InterviewAnswer } from '../../../types/interview'
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
}

export function InterviewSidebar(props:InterviewSidebarProps) {
  return <aside className="room-sidebar"><CurrentQuestion number={props.number} total={props.total} prompt={props.prompt} isFollowUp={props.isFollowUp}/><LiveTranscript answers={props.answers} draft={props.draft} interim={props.interim}/><DeviceStatus cameraStatus={props.cameraStatus} micStatus={props.micStatus} micLevel={props.micLevel} notice={props.notice}/></aside>
}
