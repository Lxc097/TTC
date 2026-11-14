import type { InterviewPhase } from '../types/interviewRoom'

export interface InterviewFlowState {
  phase: InterviewPhase
  index: number
  followUpPrompt: string | null
  followUpCount: number
  error: string | null
}

export type InterviewFlowAction =
  | {type:'SPEECH_STARTED'}
  | {type:'SPEECH_ENDED'}
  | {type:'LISTEN_STARTED'}
  | {type:'LISTEN_ENDED'}
  | {type:'SUBMIT_STARTED'}
  | {type:'FOLLOW_UP';prompt:string}
  | {type:'NEXT_QUESTION'}
  | {type:'ERROR';message:string}
  | {type:'CLEAR_ERROR'}
  | {type:'FINISH'}

export const INITIAL_INTERVIEW_FLOW: InterviewFlowState = {phase:'ready',index:0,followUpPrompt:null,followUpCount:0,error:null}

/** Events originate in browser media events, user actions, or a settled AI request. */
export function interviewFlowReducer(state:InterviewFlowState,action:InterviewFlowAction):InterviewFlowState {
  if(state.phase==='completed'&&action.type!=='FINISH')return state
  switch(action.type){
    case 'SPEECH_STARTED':return state.phase==='thinking'?state:{...state,phase:'speaking',error:null}
    case 'SPEECH_ENDED':return state.phase==='speaking'?{...state,phase:'ready'}:state
    case 'LISTEN_STARTED':return state.phase==='thinking'?state:{...state,phase:'listening',error:null}
    case 'LISTEN_ENDED':return state.phase==='listening'?{...state,phase:'ready'}:state
    case 'SUBMIT_STARTED':return {...state,phase:'thinking',error:null}
    case 'FOLLOW_UP':return {...state,phase:'ready',followUpPrompt:action.prompt,followUpCount:state.followUpCount+1,error:null}
    case 'NEXT_QUESTION':return {...state,phase:'ready',index:state.index+1,followUpPrompt:null,followUpCount:0,error:null}
    case 'ERROR':return {...state,phase:'error',error:action.message}
    case 'CLEAR_ERROR':return {...state,phase:state.phase==='error'?'ready':state.phase,error:null}
    case 'FINISH':return {...state,phase:'completed'}
  }
}
