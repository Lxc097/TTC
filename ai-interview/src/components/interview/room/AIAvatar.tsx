import type { InterviewPhase } from '../../../types/interviewRoom'

export function AIAvatar({ phase, amplitude }: { phase: InterviewPhase; amplitude: number }) {
  const energy = phase === 'speaking' ? Math.min(1, amplitude * 5) : 0
  return <div className={'room-avatar room-avatar--' + phase} style={{ '--voice-energy': energy } as React.CSSProperties} aria-label="天镜 AI 抽象头像">
    <div className="room-avatar__ring"><svg viewBox="0 0 160 160" fill="none" aria-hidden="true">
      <circle cx="80" cy="80" r="57" stroke="currentColor" strokeWidth="1.5" opacity=".3"/>
      <path d="M43 80c10-16 23-24 37-24s27 8 37 24c-10 16-23 24-37 24S53 96 43 80Z" stroke="currentColor" strokeWidth="2.5"/>
      <circle cx="80" cy="80" r="13" stroke="currentColor" strokeWidth="2.5"/>
      <path d="M80 67v-13M80 106V93M67 80H54m52 0H93" stroke="currentColor" strokeWidth="1.7" opacity=".55"/>
    </svg></div>
  </div>
}
