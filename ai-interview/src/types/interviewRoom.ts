export type InterviewPhase = 'ready' | 'speaking' | 'listening' | 'thinking' | 'error' | 'completed'

export const PHASE_LABELS: Record<InterviewPhase, string> = {
  ready: '准备回答',
  speaking: '正在提问',
  listening: '麦克风已开启',
  thinking: '正在思考',
  error: '语音暂不可用',
  completed: '面试已完成',
}
