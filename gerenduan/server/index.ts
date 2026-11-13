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

setInterval(() => {
  const now = Date.now()
  for (const [id, session] of sessions) if (now - session.createdAt > maxAgeMs) sessions.delete(id)
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
  return typeof value.role === 'string'
    && ['frontend', 'backend', 'product', 'marketing', 'general'].includes(value.role)
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

async function generateFollowUp(session: SessionState, question: InterviewQuestion, answer: string, previousPrompt: string): Promise<string> {
  const profile = DIFFICULTY_PROFILES[session.config.difficulty]
  const system = profile.interviewerStyle + ' ' + profile.followUpInstruction
    + ' 只输出一条简体中文面试追问，不要给出评分、答案、医学或人格判断。'
  const user = '岗位：' + ROLE_LABELS[session.config.role]
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

const server = createServer(async (request, response) => {
  const path = new URL(request.url || '/', 'http://127.0.0.1').pathname

  if (request.method === 'GET' && path === '/api/interview/status') {
    json(response, 200, { configured, provider: configured ? 'siliconflow' : 'local', model: configured ? llm.model : null })
    return
  }

  if (request.method === 'GET' && path === '/api/biometrics/status') {
    json(response, 200, { configured: facephysConfigured, captureSeconds: 30, mode: 'video-batch' })
    return
  }

  if (request.method === 'POST' && path === '/api/biometrics/analyze') {
    if (!facephysConfigured) {
      json(response, 503, { error: 'FacePhys 服务端凭据未配置；可切换演示模式。' })
      return
    }
    const mimeType = request.headers['content-type'] || ''
    if (!/^video\/(?:mp4|webm)(?:;|$)/i.test(mimeType)) {
      json(response, 415, { error: '仅支持 MP4 或 WebM 视频片段。' })
      return
    }
    try {
      const video = await readVideo(request)
      const result = await analyzeFacePhysVideo(video, mimeType, facephys)
      json(response, 200, result)
    } catch (error) {
      if (error instanceof FacePhysError) json(response, error.status, { error: error.message })
      else json(response, 502, { error: 'FacePhys 视频分析暂不可用；请稍后重试或切换演示模式。' })
    }
    return
  }

  if (request.method === 'POST' && path === '/api/interview/sessions') {
    try {
      const body = await readJson(request)
      if (!isRecord(body) || !isConfig(body.config)) {
        json(response, 400, { error: '面试配置无效。' })
        return
      }
      const config = body.config
      const id = randomUUID()
      if (configured) {
        try {
          const questionPlan = await generateQuestionPlan(config, llm)
          const questions = new Map(questionPlan.map((question) => [question.id, question]))
          sessions.set(id, { config: { ...config, resumeText: undefined }, questions, followUps: new Map(), createdAt: Date.now() })
          json(response, 200, { id, mode: 'siliconflow', questions: questionPlan })
        } catch (error) {
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
    sessions.delete(decodeURIComponent(path.split('/').at(-1) || ''))
    json(response, 200, { closed: true })
    return
  }

  if (request.method === 'POST' && path === '/api/interview/follow-ups') {
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
        const prompt = await generateFollowUp(session, question, answer, previousPrompt)
        json(response, 200, { mode: 'siliconflow', prompt, followUpCount: count + 1 })
      } catch (error) {
        if (session.followUps.get(question.id) === count + 1) session.followUps.set(question.id, count)
        if (error instanceof SiliconFlowError) json(response, error.status, { error: error.message })
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
