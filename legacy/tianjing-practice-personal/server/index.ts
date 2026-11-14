import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { DIFFICULTY_PROFILES } from '../src/data/difficultyProfiles'
import { createQuestionPlan } from '../src/services/interviewEngine'
import { ROLE_LABELS, TYPE_LABELS, type InterviewConfig, type InterviewQuestion } from '../src/types/interview'
import { createChatCompletion, getSiliconFlowConfig, SiliconFlowError } from './siliconflow'
import { generateQuestionPlan } from './questionPlan'
import { analyzeFacePhysVideo, FacePhysError, getFacePhysConfig, isFacePhysConfigured } from './facephys'

interface SessionState {
  config: InterviewConfig
  questions: Map<string, InterviewQuestion>
  followUps: Map<string, number>
  createdAt: number
}

const sessions = new Map<string, SessionState>()
const maxAgeMs = 60 * 60 * 1000
const port = Number(process.env.INTERVIEW_API_PORT || 8787)
const llm = getSiliconFlowConfig()
const configured = Boolean(llm.apiKey)
const facephys = getFacePhysConfig()
const facephysConfigured = isFacePhysConfigured(facephys)
const maxVideoBytes = 40 * 1024 * 1024
const trustedOrigins = new Set([
  'http://127.0.0.1:' + port,
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  process.env.INTERVIEW_WEB_ORIGIN?.trim(),
].filter((value): value is string => Boolean(value)))
const paidAttempts = new Map<string, number[]>()
let activePaidCalls = 0
const facephysAttempts: number[] = []
let activeFacephysCalls = 0
let lastSuccessfulAnalysisAt: string | null = null

class PaidCallLimitError extends Error {}

function allowTrustedOrigin(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = request.headers.origin
  if ((origin && !trustedOrigins.has(origin)) || request.headers['sec-fetch-site'] === 'cross-site') {
    json(response, 403, { error: '请求来源不受信任；请从天镜 Practice 页面操作。' })
    return false
  }
  return true
}

function allowJsonRequest(request: IncomingMessage, response: ServerResponse): boolean {
  if (!allowTrustedOrigin(request, response)) return false
  if ((request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    json(response, 415, { error: '请求必须使用 application/json。' })
    return false
  }
  return true
}

function reservePaidQuota(bucket: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const recent = (paidAttempts.get(bucket) || []).filter(at => now - at < windowMs)
  const all = (paidAttempts.get('all') || []).filter(at => now - at < windowMs)
  if (recent.length >= limit || all.length >= 60) return false
  recent.push(now)
  all.push(now)
  paidAttempts.set(bucket, recent)
  paidAttempts.set('all', all)
  return true
}

async function withPaidCall<T>(bucket: string, bucketLimit: number, task: () => Promise<T>): Promise<T> {
  if (activePaidCalls >= 2 || !reservePaidQuota(bucket, bucketLimit, 10 * 60_000)) {
    throw new PaidCallLimitError('AI 请求过于频繁，请稍后重试。')
  }
  activePaidCalls++
  try { return await task() }
  finally { activePaidCalls-- }
}

async function withFacephysCall<T>(task: () => Promise<T>): Promise<T> {
  const now = Date.now()
  while (facephysAttempts.length && now - facephysAttempts[0] >= 60 * 60_000) facephysAttempts.shift()
  if (activeFacephysCalls >= 1) throw new PaidCallLimitError('FacePhys 正在处理上一段视频，请稍后重试。')
  if (facephysAttempts.length >= 12) throw new PaidCallLimitError('FacePhys 本小时分析次数已达上限（12 次）。')
  facephysAttempts.push(now)
  activeFacephysCalls++
  try { return await task() }
  finally { activeFacephysCalls-- }
}

function safeFacePhysError(error: unknown): string {
  let raw = error instanceof Error ? error.message : '未知错误'
  if (facephys.secretKey) raw = raw.replaceAll(facephys.secretKey, '[凭据已隐藏]')
  if (facephys.keyId) raw = raw.replaceAll(facephys.keyId, '[凭据已隐藏]')
  return raw
    .replace(/(?:sk-|ke)[A-Za-z0-9_-]{16,}/g, '[凭据已隐藏]')
    .replace(/https?:\/\/\S+/gi, '[地址已隐藏]')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 260)
}

setInterval(() => {
  const now = Date.now()
  for (const [id, session] of sessions) if (now - session.createdAt > maxAgeMs) sessions.delete(id)
  for (const [bucket, attempts] of paidAttempts) {
    const recent = attempts.filter(at => now - at < 10 * 60_000)
    if (recent.length) paidAttempts.set(bucket, recent)
    else paidAttempts.delete(bucket)
  }
}, 60_000).unref()

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(data))
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > 32_768) throw new Error('请求内容过长。')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

async function readVideo(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > maxVideoBytes) throw new FacePhysError(413, 'FacePhys 视频超过 40 MB 大小限制。')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConfig(value: unknown): value is InterviewConfig {
  if (!isRecord(value)) return false
  return typeof value.targetRole === 'string'
    && value.targetRole.trim().length >= 1
    && value.targetRole.trim().length <= 120
    && typeof value.role === 'string'
    && typeof value.type === 'string'
    && ['general', 'technical', 'behavioral', 'pressure'].includes(value.type)
    && typeof value.difficulty === 'string'
    && ['basic', 'standard', 'challenge'].includes(value.difficulty)
    && typeof value.durationMinutes === 'number'
    && [5, 10, 15].includes(value.durationMinutes)
    && (value.targetRoleDescription === undefined || (typeof value.targetRoleDescription === 'string' && value.targetRoleDescription.length <= 300))
    && (value.resumeText === undefined || (typeof value.resumeText === 'string' && value.resumeText.length <= 8_000))
    && (value.resumeFileName === undefined || (typeof value.resumeFileName === 'string' && value.resumeFileName.length <= 200))
}

function questionFromModel(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return null
  const first = payload.choices[0] as unknown
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== 'string') return null
  const question = first.message.content
    .trim()
    .replace(/^[#*\s]+/, '')
    .replace(/^(追问|问题)[：:\s]*/, '')
    .split(/\r?\n/)[0]
    .trim()
    .slice(0, 240)
  return question || null
}

function summaryFromModel(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return null
  const first = payload.choices[0] as unknown
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== 'string') return null
  const summary = first.message.content
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^[#*\s]+/, '')
    .replace(/^(总结|回答表现|结论)[：:\s]*/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 480)
  return summary || null
}

async function generateFollowUp(session: SessionState, question: InterviewQuestion, answer: string, previousPrompt: string): Promise<string> {
  const profile = DIFFICULTY_PROFILES[session.config.difficulty]
  const system = profile.interviewerStyle + ' ' + profile.followUpInstruction
    + ' 只输出一条简体中文面试追问，不要给出评分、答案、医学或人格判断。'
  const user = '岗位：' + session.config.targetRole
    + '\n面试类型：' + TYPE_LABELS[session.config.type]
    + '\n原题：' + question.prompt
    + (previousPrompt ? '\n上一条追问：' + previousPrompt : '')
    + '\n面试者刚才的回答：' + answer
    + '\n请基于该回答提出一条有针对性的追问。'

  const response = await createChatCompletion(llm,
    [{ role: 'system', content: system }, { role: 'user', content: user }], 180)
  const result = questionFromModel(response)
  if (!result) throw new Error('硅基流动没有返回有效追问。')
  return result
}

async function generateAnswerSummary(session: SessionState, question: InterviewQuestion, answer: string): Promise<string> {
  const role = (session.config as typeof session.config & { targetRole?: string }).targetRole?.trim()
    || session.config.targetRoleDescription?.trim() || ROLE_LABELS[session.config.role]
  const profile = DIFFICULTY_PROFILES[session.config.difficulty]
  const system = profile.interviewerStyle
    + ' 你是严谨的岗位面试复盘助手。仅根据面试者回答的原文与当前题目，输出两到三句简体中文内容分析。'
    + ' 先判断回答是否有效、是否回应问题；无效、跑题或证据不足时明确说无法判断，不得推断能力。'
    + ' 有效回答需引用回答中真实出现的短语，指出覆盖了什么、缺少什么岗位相关证据，并给出下一次可执行的补充方向。'
    + ' 不能编造项目、数字、结果或经历；不得做心理、人格、诚信、健康或录用判断，不得引用摄像头或生理信号，不给分数，不使用套话。'
  const user = '目标岗位：' + role
    + '\n原题：' + question.prompt
    + '\n本题考察点：' + question.keywords.join('、')
    + '\n面试者回答：' + answer
    + '\n请依据这段真实回答写 60-180 字；没有证据时直说证据不足。建议补充真实可核查的事实，可使用[具体工作]等占位符，不要代写虚构经历。'
  const response = await createChatCompletion(llm,
    [{ role: 'system', content: system }, { role: 'user', content: user }], 260)
  const result = summaryFromModel(response)
  if (!result) throw new Error('硅基流动没有返回有效回答总结。')
  return result
}

const server = createServer(async (request, response) => {
  let path: string
  try { path = new URL(request.url || '/', 'http://127.0.0.1').pathname }
  catch { json(response, 400, { error: '请求地址无效。' }); return }

  if (request.method === 'GET' && path === '/api/interview/status') {
    json(response, 200, { configured, provider: configured ? 'siliconflow' : 'local', model: configured ? llm.model : null })
    return
  }

  if (request.method === 'GET' && path === '/api/biometrics/status') {
    json(response, 200, {
      configured: facephysConfigured,
      verified: lastSuccessfulAnalysisAt !== null,
      lastSuccessfulAnalysisAt,
      captureSeconds: 30,
      mode: 'video-batch',
    })
    return
  }

  if (request.method === 'POST' && path === '/api/biometrics/analyze') {
    if (!allowTrustedOrigin(request, response)) return
    if (!facephysConfigured) {
      json(response, 503, { error: 'FacePhys 服务端凭据未配置，本次仅生成回答内容报告。' })
      return
    }
    const mimeType = request.headers['content-type'] || ''
    if (!/^video\/(?:mp4|webm)(?:;|$)/i.test(mimeType)) {
      json(response, 415, { error: '仅支持 MP4 或 WebM 视频片段。' })
      return
    }
    try {
      const video = await readVideo(request)
      if (!video.byteLength) { json(response, 400, { error: '视频内容为空。' }); return }
      const result = await withFacephysCall(() => analyzeFacePhysVideo(video, mimeType, facephys))
      lastSuccessfulAnalysisAt = new Date().toISOString()
      json(response, 200, result)
    } catch (error) {
      if (error instanceof PaidCallLimitError) json(response, 429, { error: error.message })
      else if (error instanceof FacePhysError) json(response, error.status, { error: error.message })
      else json(response, 502, { error: 'FacePhys 视频分析暂不可用：' + safeFacePhysError(error) })
    }
    return
  }

  if (request.method === 'POST' && path === '/api/interview/sessions') {
    if (!allowJsonRequest(request, response)) return
    try {
      const body = await readJson(request)
      if (!isRecord(body) || !isConfig(body.config)) {
        json(response, 400, { error: '面试配置无效。' })
        return
      }
      const config: InterviewConfig = {
        ...body.config,
        targetRole: body.config.targetRole.trim(),
        role: ['frontend', 'backend', 'product', 'marketing', 'general'].includes(body.config.role)
          ? body.config.role : 'general',
      }
      const id = randomUUID()
      if (configured) {
        try {
          const questionPlan = await withPaidCall('question-plan', 8, () => generateQuestionPlan(config, llm))
          const questions = new Map(questionPlan.map((question) => [question.id, question]))
          sessions.set(id, { config: { ...config, resumeText: undefined }, questions, followUps: new Map(), createdAt: Date.now() })
          json(response, 200, { id, mode: 'siliconflow', questions: questionPlan })
        } catch (error) {
          if (error instanceof PaidCallLimitError) {
            json(response, 429, { error: error.message })
            return
          }
          const notice = error instanceof SiliconFlowError ? error.message
            : error instanceof Error && error.message === 'DeepSeek 未返回完整的结构化题目。' ? error.message
              : 'DeepSeek 出题暂不可用，已切换本地题库。'
          json(response, 200, { id, mode: 'local', questions: createQuestionPlan(config), notice })
        }
      } else {
        json(response, 200, { id, mode: 'local', questions: createQuestionPlan(config), notice: '未配置 SILICONFLOW_API_KEY，当前使用本地题库。' })
      }
    } catch {
      json(response, 400, { error: '无法读取面试配置。' })
    }
    return
  }

  if (request.method === 'DELETE' && /^\/api\/interview\/sessions\/[^/]+$/.test(path)) {
    let id: string
    try { id = decodeURIComponent(path.split('/').at(-1) || '') }
    catch { json(response, 400, { error: '面试会话 ID 无效。' }); return }
    sessions.delete(id)
    json(response, 200, { closed: true })
    return
  }

  if (request.method === 'POST' && path === '/api/interview/answer-summary') {
    if (!allowJsonRequest(request, response)) return
    try {
      const body = await readJson(request)
      if (!isRecord(body)
        || typeof body.sessionId !== 'string'
        || typeof body.questionId !== 'string'
        || typeof body.answer !== 'string') {
        json(response, 400, { error: '回答总结请求无效。' })
        return
      }
      if (!configured) {
        json(response, 503, { error: 'SILICONFLOW_API_KEY 未设置；当前只能使用本地回答总结。' })
        return
      }
      const session = sessions.get(body.sessionId)
      const question = session?.questions.get(body.questionId)
      if (!session || !question || Date.now() - session.createdAt > maxAgeMs) {
        json(response, 404, { error: '面试会话或题目不存在。' })
        return
      }
      const answer = body.answer.trim()
      if (!answer || answer.length > 5_000) {
        json(response, 400, { error: '回答内容为空或过长。' })
        return
      }
      if (answer.replace(/\s/g, '').length < 8 || !/[\p{L}]/u.test(answer)) {
        json(response, 200, { mode: 'local', summary: '本次回答未包含可用于评价该问题的信息，无法判断相关能力表现；请围绕问题重新作答。' })
        return
      }
      const summary = await withPaidCall('summary:' + body.sessionId, 50,
        () => generateAnswerSummary(session, question, answer))
      json(response, 200, { mode: 'siliconflow', summary })
    } catch (error) {
      if (error instanceof PaidCallLimitError) json(response, 429, { error: error.message })
      else if (error instanceof SiliconFlowError) json(response, error.status, { error: error.message })
      else if (error instanceof Error && error.name === 'TimeoutError') json(response, 504, { error: '硅基流动请求超时；已保留本地回答总结。' })
      else json(response, 502, { error: '硅基流动回答总结暂不可用；已保留本地回答总结。' })
    }
    return
  }

  if (request.method === 'POST' && path === '/api/interview/follow-ups') {
    if (!allowJsonRequest(request, response)) return
    try {
      const body = await readJson(request)
      if (!isRecord(body)
        || typeof body.sessionId !== 'string'
        || typeof body.questionId !== 'string'
        || typeof body.answer !== 'string'
        || !Number.isInteger(body.followUpCount)) {
        json(response, 400, { error: '追问请求无效。' })
        return
      }
      if (!configured) {
        json(response, 503, { error: 'SILICONFLOW_API_KEY 未设置；请使用本地题库模式。' })
        return
      }
      const session = sessions.get(body.sessionId)
      const question = session?.questions.get(body.questionId)
      if (!session || !question || Date.now() - session.createdAt > maxAgeMs) {
        json(response, 404, { error: '面试会话或题目不存在。' })
        return
      }
      const answer = body.answer.trim()
      if (!answer || answer.length > 5_000) {
        json(response, 400, { error: '回答内容为空或过长。' })
        return
      }
      const count = session.followUps.get(question.id) || 0
      if (body.followUpCount !== count) {
        json(response, 409, { error: '追问状态不同步。' })
        return
      }
      if (count >= DIFFICULTY_PROFILES[session.config.difficulty].maxFollowUps) {
        json(response, 409, { error: '已达到本题追问次数上限。' })
        return
      }
      const previousPrompt = typeof body.previousPrompt === 'string' ? body.previousPrompt.slice(0, 300) : ''
      // Reserve the slot before awaiting the network to reject duplicate submissions.
      session.followUps.set(question.id, count + 1)
      try {
        const prompt = await withPaidCall('follow-up:' + body.sessionId, 30,
          () => generateFollowUp(session, question, answer, previousPrompt))
        json(response, 200, { mode: 'siliconflow', prompt, followUpCount: count + 1 })
      } catch (error) {
        if (session.followUps.get(question.id) === count + 1) session.followUps.set(question.id, count)
        if (error instanceof PaidCallLimitError) json(response, 429, { error: error.message })
        else if (error instanceof SiliconFlowError) json(response, error.status, { error: error.message })
        else if (error instanceof Error && error.name === 'TimeoutError')
          json(response, 504, { error: '硅基流动请求超时；可继续本地题库追问。' })
        else json(response, 502, { error: '硅基流动连接或响应异常；可继续本地题库追问。' })
      }
    } catch {
      json(response, 400, { error: '无法读取追问请求。' })
    }
    return
  }

  json(response, 404, { error: '接口不存在。' })
})

server.listen(port, '127.0.0.1', () => {
  console.log('Interview API ready at http://127.0.0.1:' + port + ' (' + (configured ? 'SiliconFlow configured' : 'local fallback') + ')')
})
