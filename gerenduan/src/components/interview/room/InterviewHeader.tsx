import { Clock3 } from 'lucide-react'
import { DIFFICULTY_LABELS, ROLE_LABELS, TYPE_LABELS, type InterviewConfig } from '../../../types/interview'
import { PHASE_LABELS, type InterviewPhase } from '../../../types/interviewRoom'

export function InterviewHeader({config,phase,remaining,number,total}:{config:InterviewConfig;phase:InterviewPhase;remaining:number;number:number;total:number}) {
  const time=Math.max(0,remaining)
  return <header className="room-header"><div><span className="room-header__eyebrow">天镜 Practice / 模拟面试</span><h1>{config.targetRoleDescription?.trim() || ROLE_LABELS[config.role]} <span>{TYPE_LABELS[config.type]} · {DIFFICULTY_LABELS[config.difficulty]}</span></h1></div><div className="room-header__right"><span className={'room-phase room-phase--'+phase}><i/>{PHASE_LABELS[phase]}</span><span className="room-header__count">{number} / {total} 题</span><span className={time<=60?'room-header__timer is-urgent':'room-header__timer'}><Clock3 size={16}/>{String(Math.floor(time/60)).padStart(2,'0')}:{String(time%60).padStart(2,'0')}</span></div></header>
}
