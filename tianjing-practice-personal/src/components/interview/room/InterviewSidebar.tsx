import type { InterviewAnswer, QuestionReaction } from '../../../types/interview'
import { LiveTranscript } from './LiveTranscript'
import { DeviceStatus } from './DeviceStatus'

interface InterviewSidebarProps {
  number: number
  total: number
  prompt: string
  isFollowUp: boolean
  answers: InterviewAnswer[]
  draft: string
  interim: string
  cameraStatus: string
  micStatus: string
  micLevel: number
  notice?: string
  reaction: QuestionReaction
  onDraftChange: (text: string) => void
  onEditFocus?: () => void
  onEditBlur?: () => void
  manualEditing?: boolean
  pendingTranscript?: string
  onMergeTranscript?: () => void
}

export function InterviewSidebar(props: InterviewSidebarProps) {
  return <aside className="room-sidebar" aria-label="回答与设备状态">
    <LiveTranscript
      draft={props.draft}
      interim={props.interim}
      onDraftChange={props.onDraftChange}
      onEditFocus={props.onEditFocus}
      onEditBlur={props.onEditBlur}
      manualEditing={props.manualEditing}
      pendingTranscript={props.pendingTranscript}
      onMergeTranscript={props.onMergeTranscript}
    />
    <DeviceStatus cameraStatus={props.cameraStatus} micStatus={props.micStatus} micLevel={props.micLevel} notice={props.notice} />
  </aside>
}
