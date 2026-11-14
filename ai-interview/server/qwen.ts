/** Server-only Qwen adapter. Never import this module into browser code. */
export interface QwenConfig {
  baseUrl: string
  model: string
  apiKey: string
  asrModel?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export const QWEN_ASR_MODEL = 'qwen3-asr-flash'

export class QwenError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'QwenError'
  }
}

export function getQwenConfig(): QwenConfig {
  return {
    baseUrl: process.env.DASHSCOPE_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: process.env.QWEN_TEXT_MODEL?.trim() || 'qwen3.8-max',
    apiKey: process.env.DASHSCOPE_API_KEY?.trim() || '',
    asrModel: process.env.QWEN_ASR_MODEL?.trim() || QWEN_ASR_MODEL,
  }
}

function endpointUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl)
  if (url.pathname.replace(/\/+$/, '').split('/').at(-1) !== 'v1') {
    throw new Error('DASHSCOPE_BASE_URL 必须以 /v1 结尾。')
  }
  return url.toString().replace(/\/+$/, '') + '/' + endpoint
}

function safeDetail(payload: unknown, apiKey: string): string {
  const object = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  const error = object?.error
  const value = typeof payload === 'string' ? payload
    : typeof error === 'string' ? error
      : error && typeof error === 'object' ? (error as Record<string, unknown>).message
        : object?.message
  if (typeof value !== 'string') return ''
  return value.replaceAll(apiKey, '[密钥已隐藏]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[密钥已隐藏]')
    .replace(/<[^>]*>/g, ' ').replace(/[\r\n]+/g, ' ').trim().slice(0, 400)
}

function statusMessage(status: number): string {
  switch (status) {
    case 401: return '千问认证失败（401）：请检查密钥和地域'
    case 404: return '千问模型不存在或当前业务空间不可用（404）：请核对模型 ID'
    case 429: return '千问调用达到限流（429）：请稍后重试'
    case 503: return '千问模型暂时过载（503）：请稍后重试'
    default: return '千问请求失败（HTTP ' + status + '）'
  }
}

/** One OpenAI-compatible chat completion request. No retries or hidden extra calls. */
export async function createChatCompletion(
  config: QwenConfig,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<ChatCompletion> {
  if (!config.apiKey) throw new Error('DASHSCOPE_API_KEY 未设置。')
  const response = await fetch(endpointUrl(config.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
    body: JSON.stringify({ model: config.model, messages, max_tokens: maxTokens, stream: false }),
    signal: AbortSignal.timeout(30_000),
  })
  const raw = await response.text()
  let payload: unknown
  try { payload = JSON.parse(raw) as unknown }
  catch { payload = raw.slice(0, 5_000) }
  if (!response.ok) {
    const detail = safeDetail(payload, config.apiKey)
    throw new QwenError(response.status, statusMessage(response.status) + (detail ? '；上游信息：' + detail : '。'))
  }
  if (!payload || typeof payload !== 'object') throw new Error('千问返回了无效的 JSON。')
  return payload as ChatCompletion
}

/** One server-side ASR request. The browser never receives the API key. */
export async function createAudioTranscription(
  config: QwenConfig, audio: Uint8Array, mimeType: string,
): Promise<string> {
  if (!config.apiKey) throw new Error('DASHSCOPE_API_KEY 未设置。')
  const data = 'data:' + mimeType + ';base64,' + Buffer.from(audio).toString('base64')
  const response = await fetch(endpointUrl(config.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
    body: JSON.stringify({
      model: config.asrModel || QWEN_ASR_MODEL,
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data } }] }],
      asr_options: { language: 'zh' },
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  const raw = await response.text()
  let payload: unknown
  try { payload = JSON.parse(raw) as unknown }
  catch { payload = raw.slice(0, 5_000) }
  if (!response.ok) {
    const detail = safeDetail(payload, config.apiKey)
    throw new QwenError(response.status, statusMessage(response.status) + (detail ? '；上游信息：' + detail : '。'))
  }
  const content = (payload as ChatCompletion | null)?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('千问返回了无效的转录结果。')
  return content.trim().slice(0, 5_000)
}
