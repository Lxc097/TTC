import { useState } from 'react'
import { Volume2 } from 'lucide-react'
import { CameraPiP } from '../../camera/CameraPiP'
import { AudioWaveform } from '../AudioWaveform'
import { AIAvatar } from './AIAvatar'
import { PHASE_LABELS, type InterviewPhase } from '../../../types/interviewRoom'

interface AIStageProps {
  phase: InterviewPhase
  prompt: string
  number: number
  ttsAnalyser: AnalyserNode | null
  micAnalyser: AnalyserNode | null
  onReplay: () => void
  onVideoElement: (element: HTMLVideoElement | null) => void
}

export function AIStage({phase,prompt,number,ttsAnalyser,micAnalyser,onReplay,onVideoElement}:AIStageProps) {
  const [amplitude,setAmplitude]=useState(0)
  const isSpeaking=phase==='speaking'
  const isListening=phase==='listening'
  return <section className="room-stage" aria-label="AI 面试官主舞台"><div className="room-stage__top"><span className="room-stage__identity"><span className="room-stage__identity-mark">✧</span>天镜 AI 面试官</span><span className={'room-stage__state room-stage__state--'+phase}><i/>{PHASE_LABELS[phase]}</span></div><div className="room-stage__center"><AIAvatar phase={phase} amplitude={amplitude}/><div className="room-stage__wave"><AudioWaveform analyser={isSpeaking?ttsAnalyser:isListening?micAnalyser:null} kind={isSpeaking?'ai':isListening?'user':phase==='thinking'?'thinking':'ai'} active={isSpeaking||isListening||phase==='thinking'} onAmplitude={setAmplitude}/></div><p>{isSpeaking?'可听朗读，也可阅读右侧题目并打字回答':isListening?'麦克风已开启；也可直接输入文字':phase==='thinking'?'正在根据你的回答准备下一步':'可以阅读右侧问题，或点击重新朗读'}</p></div><div className="room-stage__bottom"><span>问题 {String(number).padStart(2,'0')}</span><button type="button" onClick={onReplay}><Volume2 size={16}/>重新朗读</button></div><div className="room-stage__mobile-question">{prompt}</div><CameraPiP onVideoElement={onVideoElement}/></section>
}
