import { DIFFICULTY_PROFILES } from '../data/difficultyProfiles'
import type { InterviewConfig, InterviewQuestion } from '../types/interview'
import { pickFollowUp } from './interviewEngine'
import { createQuestionPlan } from './interviewEngine'
import { localAnswerSummary } from '../utils/answerInsight'

export type InterviewServiceMode = 'siliconflow' | 'local'

export interface InterviewServiceSession {
  id: string
  mode: InterviewServiceMode
  config: InterviewConfig
  questions: InterviewQuestion[]
  notice?: string
}

export interface FollowUpRequest {
  session: InterviewServiceSession
  question: InterviewQuestion
  answer: string
  /** Number of follow-ups already asked for this base question. */
  followUpCount: number
  previousPrompt?: string
}

export interface FollowUpResult {
  prompt: string | null
  mode: InterviewServiceMode
  notice?: string
}

export interface AnswerSummaryRequest {
  session: InterviewServiceSession
  question: InterviewQuestion
  answer: string
}

export interface AnswerSummaryResult {
  summary: string
  mode: 'siliconflow' | 'local'
  notice?: string
}

function localSession(config: InterviewConfig, notice?: string): InterviewServiceSession {
  return { id: 'local-' + crypto.randomUUID(), mode: 'local', config, questions: createQuestionPlan(config), notice }
}

function isQuestionPlan(value: unknown): value is InterviewQuestion[] {
  return Array.isArray(value) && value.length > 0 && value.every(item =>
    item && typeof item === 'object' && typeof item.id === 'string'
      && typeof item.prompt === 'string' && Array.isArray(item.keywords))
}

const pendingStarts = new Map<string, Promise<InterviewServiceSession>>()

/** Deduplicate React development-effect replays so one setup creates one paid question plan. */
export function startInterviewService(config: InterviewConfig): Promise<InterviewServiceSession> {
  const key = JSON.stringify(config)
  const pending = pendingStarts.get(key)
  if (pending) return pending
  const started = startInterviewServiceOnce(config)
  pendingStarts.set(key, started)
  void started.finally(() => { if (pendingStarts.get(key) === started) pendingStarts.delete(key) })
  return started
}

/** A local session is returned if the optional proxy is unavailable or unconfigured. */
async function startInterviewServiceOnce(config: InterviewConfig): Promise<InterviewServiceSession> {
  try {
    const response = await fetch('/api/interview/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    })
    if (!response.ok) return localSession(config, await readPublicError(response) || 'AI 出题服务暂不可用，已使用本地题库。')
    const data = await response.json() as { id?: unknown; mode?: unknown; questions?: unknown; notice?: unknown }
    const notice = typeof data.notice === 'string' ? data.notice : undefined
    if (typeof data.id !== 'string' || data.mode !== 'siliconflow' || !isQuestionPlan(data.questions)) {
      return localSession(config, notice || 'AI 出题服务未返回有效题目，已使用本地题库。')
    }
    return { id: data.id, mode: 'siliconflow', config, questions: data.questions, notice }
  } catch { return localSession(config, '无法连接 AI 出题服务，已使用本地题库。') }
}

function localFollowUp(request: FollowUpRequest, notice?: string): FollowUpResult {
  return {
    prompt: pickFollowUp(request.answer, request.question, request.session.config, request.followUpCount),
    mode: 'local',
    notice: notice ?? '当前使用本地题库追问规则。',
  }
}

async function readPublicError(response: Response): Promise<string | null> {
  try {
    const data = await response.json() as { error?: unknown }
    if (typeof data.error !== 'string') return null
    const message = data.error.trim()
    if (!message) return null
    return message.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[密钥已隐藏]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [密钥已隐藏]')
      .replace(/https?:\/\/\S+/gi, '[地址已隐藏]')
      .slice(0, 240)
  } catch { return null }
}

/** AI requests go only through the same-origin server proxy; no key enters the browser. */
export async function requestFollowUp(request: FollowUpRequest): Promise<FollowUpResult> {
  const limit = DIFFICULTY_PROFILES[request.session.config.difficulty].maxFollowUps
  if (!request.answer.trim() || request.followUpCount >= limit) {
    return { prompt: null, mode: request.session.mode }
  }
  if (request.session.mode === 'local') return localFollowUp(request)

  try {
    const response = await fetch('/api/interview/follow-ups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: request.session.id,
        questionId: request.question.id,
        answer: request.answer,
        followUpCount: request.followUpCount,
        previousPrompt: request.previousPrompt,
      }),
    })
    if (!response.ok) {
      const serverError = await readPublicError(response)
      if (response.status === 409) {
        return { prompt: null, mode: 'siliconflow', notice: `${serverError || '会话状态已变化'}；本轮不会重新提交，请继续下一题。` }
      }
      return localFollowUp(request, `${serverError || 'AI 追问服务暂不可用'}，已切换本地追问规则。`)
    }
    const data = await response.json() as { prompt?: unknown; mode?: unknown }
    if (typeof data.prompt !== 'string' || !data.prompt.trim()) {
      return localFollowUp(request, 'AI 未返回有效追问，已使用本地规则。')
    }
    return { prompt: data.prompt.trim(), mode: 'siliconflow' }
  } catch {
    return localFollowUp(request, '连接 AI 追问服务失败，已切换本地追问规则。')
  }
}

/** Summarise answer content through the proxy; the local result is deterministic and explainable. */
export async function summarizeAnswer(request: AnswerSummaryRequest): Promise<AnswerSummaryResult> {
  const answer = request.answer.trim()
  if (answer.replace(/\s/g, '').length < 8 || !/[\p{L}]/u.test(answer)) return { summary: localAnswerSummary(answer), mode: 'local' }
  if (request.session.mode === 'local') return { summary: localAnswerSummary(answer), mode: 'local' }
  try {
    const response = await fetch('/api/interview/answer-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: request.session.id, questionId: request.question.id, answer }),
    })
    if (!response.ok) {
      return {
        summary: localAnswerSummary(answer),
        mode: 'local',
        notice: (await readPublicError(response)) || 'DeepSeek 回答总结暂不可用，已使用本地规则。',
      }
    }
    const data = await response.json() as { summary?: unknown; mode?: unknown }
    if (typeof data.summary !== 'string' || !data.summary.trim()) {
      return { summary: localAnswerSummary(answer), mode: 'local', notice: 'DeepSeek 未返回有效回答总结，已使用本地规则。' }
    }
    return { summary: data.summary.trim(), mode: data.mode === 'local' ? 'local' : 'siliconflow' }
  } catch {
    return { summary: localAnswerSummary(answer), mode: 'local', notice: '连接 DeepSeek 失败，已使用本地回答总结。' }
  }
}

export async function closeInterviewService(session: InterviewServiceSession | null): Promise<void> {
  if (!session || session.mode !== 'siliconflow') return
  try {
    await fetch('/api/interview/sessions/' + encodeURIComponent(session.id), { method: 'DELETE', keepalive: true })
  } catch { /* Local report generation and camera cleanup must not depend on the proxy. */ }
}
