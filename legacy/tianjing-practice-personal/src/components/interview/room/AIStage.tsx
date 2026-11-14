import { Volume2 } from 'lucide-react'
import { CameraPiP } from '../../camera/CameraPiP'
import { AudioWaveform } from '../AudioWaveform'
import { PHASE_LABELS, type InterviewPhase } from '../../../types/interviewRoom'

interface AIStageProps {
  phase: InterviewPhase
  prompt: string
  number: number
  total?: number
  ttsAnalyser: AnalyserNode | null
  micAnalyser: AnalyserNode | null
  onReplay: () => void
  onVideoElement: (element: HTMLVideoElement | null) => void
}

/** The question, rather than an avatar, is the visual center of the interview. */
export function AIStage({ phase, prompt, number, total, ttsAnalyser, micAnalyser, onReplay, onVideoElement }: AIStageProps) {
  const speaking = phase === 'speaking'
  const listening = phase === 'listening'
  const kind = speaking ? 'ai' : listening ? 'user' : phase === 'thinking' ? 'thinking' : 'ai'
  const analyser = speaking ? ttsAnalyser : listening ? micAnalyser : null

  return <section className={'room-stage room-stage--' + phase} aria-label="AI 面试问答区">
    <div className="room-stage__top">
      <span className="room-stage__identity"><span className="room-stage__identity-mark" aria-hidden="true">✧</span>天镜 AI 面试官</span>
      <span className={'room-stage__state room-stage__state--' + phase}><i aria-hidden="true" />{PHASE_LABELS[phase]}</span>
    </div>
    <div className="room-stage__question" key={prompt}>
      <span className="room-stage__number">第 {String(number).padStart(2, '0')} 题{total ? ' / 共 ' + String(total).padStart(2, '0') + ' 题' : ''}</span>
      <h2>{prompt}</h2>
    </div>
    <div className="room-stage__audio">
      <div className="room-stage__audio-label"><span className={listening ? 'is-listening' : ''} />{speaking ? 'AI 正在朗读' : listening ? '正在接收你的回答' : phase === 'thinking' ? '正在准备下一步' : '题目已显示'}</div>
      <AudioWaveform analyser={analyser} kind={kind} active={speaking || listening || phase === 'thinking'} />
      <button type="button" onClick={onReplay} aria-label="重新朗读当前问题"><Volume2 size={16} />重新朗读</button>
    </div>
    <CameraPiP onVideoElement={onVideoElement} />
  </section>
}
