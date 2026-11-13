import { Clock3 } from 'lucide-react'

export function InterviewTimer({seconds}:{seconds:number}) {
  const remaining = Math.max(0,seconds)
  return <div className={remaining<=60?'interview-timer urgent':'interview-timer'}><Clock3 size={16}/><span>{String(Math.floor(remaining/60)).padStart(2,'0')}:{String(remaining%60).padStart(2,'0')}</span></div>
}
