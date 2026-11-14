import type { InterviewPhase } from '../types/interviewRoom'

export interface AutoSubmitConditions {
  enabled:boolean
  phase:InterviewPhase
  firstVoiceAt:number|null
  lastVoiceAt:number|null
  now:number
  hasText:boolean
}

/** A deadline may begin only after real voice activity and valid transcript text. */
export function shouldStartAutoSubmit({enabled,phase,firstVoiceAt,lastVoiceAt,now,hasText}:AutoSubmitConditions):boolean {
  return enabled&&phase==='listening'&&hasText&&firstVoiceAt!==null&&lastVoiceAt!==null
    &&now-firstVoiceAt>=12_000&&now-lastVoiceAt>=8_000
}
