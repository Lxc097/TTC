import type { InterviewAnswer, InterviewConfig } from '../types/interview'

const STORAGE_KEY = 'ttc.ai.formal-attempt'
const AUTH_KEY = 'ttc.recruitment.candidate.auth'

export interface FormalContext {
  applicationId: string
  attemptId: string
  config: InterviewConfig
  createdAt: number
}

function candidateToken(): string {
  try {
    const auth = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null') as { token?: unknown; user?: { role?: unknown } } | null
    if (auth?.user?.role === 'candidate' && typeof auth.token === 'string' && auth.token) return auth.token
  } catch { /* Login state was removed or malformed. */ }
  throw new Error('请先在候选人端登录，再进入 AI 初面。')
}

export async function formalFetch(path: string, body: object): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + candidateToken() },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    let detail = ''
    try {
      const data = await response.json() as { detail?: unknown; error?: unknown }
      const value = typeof data.detail === 'string' ? data.detail : data.error
      if (typeof value === 'string') detail = value.slice(0, 160)
    } catch { /* Keep the fallback below. */ }
    throw new Error(detail || (response.status === 401 ? '登录已失效，请重新登录。' : '初面服务暂不可用，请稍后重试。'))
  }
  const data: unknown = await response.json()
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('初面服务返回无效数据。')
  return data as Record<string, unknown>
}

export function getFormalContext(): FormalContext | null {
  try {
    const context = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') as FormalContext | null
    if (!context || typeof context.applicationId !== 'string' || typeof context.attemptId !== 'string'
      || typeof context.createdAt !== 'number' || Date.now() - context.createdAt > 3 * 60 * 60 * 1000
      || !context.config || typeof context.config.role !== 'string') return null
    return context
  } catch { return null }
}

export function saveFormalContext(context: FormalContext): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(context))
}

export function clearFormalContext(): void {
  sessionStorage.removeItem(STORAGE_KEY)
}

export async function prepareFormalInterview(applicationId: string): Promise<FormalContext> {
  const data = await formalFetch('/api/applications/' + encodeURIComponent(applicationId) + '/ai-interview/start', {})
  if (typeof data.attemptId !== 'string' || !data.config || typeof data.config !== 'object'
    || Array.isArray(data.config)) throw new Error('初面配置不完整。')
  const config = data.config as InterviewConfig
  if (!['frontend', 'backend', 'product', 'marketing', 'general'].includes(config.role)
    || !['general', 'technical', 'behavioral', 'pressure'].includes(config.type)
    || ![5, 10, 15].includes(config.durationMinutes)) throw new Error('初面配置无效。')
  return { applicationId, attemptId: data.attemptId, config, createdAt: Date.now() }
}

export async function saveFormalAnswer(context: FormalContext, answer: InterviewAnswer): Promise<void> {
  await formalFetch('/api/applications/' + encodeURIComponent(context.applicationId) + '/ai-interview/answers', {
    attemptId: context.attemptId, questionId: answer.questionId, prompt: answer.prompt, answer: answer.answer,
  })
}

export async function completeFormalInterview(context: FormalContext): Promise<void> {
  const data = await formalFetch('/api/applications/' + encodeURIComponent(context.applicationId) + '/ai-interview/complete',
    { attemptId: context.attemptId })
  if (data.status !== 'completed') throw new Error('服务端尚未确认本次初面完成。')
}
