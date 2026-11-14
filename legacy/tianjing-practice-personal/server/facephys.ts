import { createHmac } from 'node:crypto'
import type { BiometricReading, SignalQuality } from '../src/services/biometrics/types'

/** FacePhys V3 cloud video API. Credentials must stay in the Node process. */
export interface FacePhysConfig {
  baseUrl: string
  keyId: string
  secretKey: string
}

export class FacePhysError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'FacePhysError'
  }
}

export interface FacePhysAnalysis {
  source: 'api'
  readings: BiometricReading[]
  videoDurationSeconds?: number
  /** Actual provider data only; unsafe transport/credential fields are removed. */
  rawData: Record<string, unknown>
}

// FacePhys is behind a WAF that rejects the default Node.js user agent.
// Keep this value stable for the presign and process requests; credentials remain server-side.
const FACEPHYS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

export function getFacePhysConfig(): FacePhysConfig {
  return {
    baseUrl: process.env.FACEPHYS_BASE_URL?.trim() || 'https://www.facephys.com',
    keyId: process.env.FACEPHYS_KEY_ID?.trim() || '',
    secretKey: process.env.FACEPHYS_SECRET_KEY?.trim() || '',
  }
}

export function isFacePhysConfigured(config = getFacePhysConfig()): boolean {
  return Boolean(config.keyId && config.secretKey)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Keep provider measurements auditable without exposing upload links, media, or secrets. */
function safeAnalysisData(data: Record<string, unknown>, config: FacePhysConfig): Record<string, unknown> {
  const blockedKey = /(?:secret|credential|password|authorization|signature|token|api.?key|key.?id|object.?key|upload|presign|(?:^|_)(?:url|uri|image|video|frame|blob|base64)(?:$|_))/i
  const clean = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'string') {
      if (value.length > 2000 || value.startsWith('data:') || value.startsWith('http://')
        || value.startsWith('https://') || new RegExp('^[A-Za-z0-9+/]{200,}={0,2}$', 'i').test(value)) return '[非分析文本已隐藏]'
      let result = value.slice(0, 400)
      for (const secret of [config.keyId, config.secretKey]) if (secret) result = result.replaceAll(secret, '[凭据已隐藏]')
      return result.replace(/(?:sk-|ke)[A-Za-z0-9_-]{16,}/g, '[凭据已隐藏]')
    }
    if (depth >= 6) return '[超过展示深度]'
    if (Array.isArray(value)) {
      const entries = value.slice(0, 240).map(item => clean(item, depth + 1))
      if (value.length > 240) entries.push('[后续条目未保存]')
      return entries
    }
    const object = record(value)
    if (!object) return null
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(object).slice(0, 80)) {
      if (!blockedKey.test(key)) result[key] = clean(item, depth + 1)
    }
    if (Object.keys(object).length > 80) result.__note = '仅保留前 80 个字段'
    return result
  }
  return clean(data, 0) as Record<string, unknown>
}

function safeDetail(value: unknown, config: FacePhysConfig): string {
  const object = record(value)
  const error = record(object?.error)
  const detail = typeof object?.error === 'string' ? object.error
    : typeof error?.message === 'string' ? error.message
      : typeof object?.message === 'string' ? object.message
        : typeof value === 'string' ? value : ''
  return detail.replaceAll(config.secretKey, '[凭据已隐藏]')
    .replaceAll(config.keyId, '[凭据已隐藏]')
    .replace(/(?:sk-|ke)[A-Za-z0-9_-]{16,}/g, '[凭据已隐藏]')
    .replace(/https?:\/\/\S+/gi, '[地址已隐藏]')
    .replace(/[\r\n]+/g, ' ').trim().slice(0, 240)
}

function statusMessage(status: number, step: string): string {
  switch (status) {
    case 400: return 'FacePhys ' + step + '失败：视频格式或请求参数无效'
    case 401: return 'FacePhys 鉴权失败：请检查服务端 Key ID、Secret 和系统时间'
    case 403: return 'FacePhys 拒绝请求：请检查权限、有效期或额度'
    case 413: return 'FacePhys 视频超过大小限制'
    case 429: return 'FacePhys 限流：请稍后重试'
    case 503: return 'FacePhys 计算节点暂不可用：请稍后重试'
    case 504: return 'FacePhys 处理超时：请稍后重试'
    default: return 'FacePhys ' + step + '失败（HTTP ' + status + '）'
  }
}

async function readJson(response: Response, step: string, config: FacePhysConfig): Promise<Record<string, unknown>> {
  const raw = await response.text()
  let payload: unknown
  try { payload = JSON.parse(raw) as unknown }
  catch { payload = raw }
  if (!response.ok) {
    const detail = safeDetail(payload, config)
    throw new FacePhysError(response.status, statusMessage(response.status, step) + (detail ? '；上游信息：' + detail : '。'))
  }
  const parsed = record(payload)
  if (!parsed) throw new Error('FacePhys ' + step + '返回无效 JSON。')
  return parsed
}

function authHeaders(config: FacePhysConfig): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  return {
    'x-key-id': config.keyId,
    'x-timestamp': timestamp,
    'x-signature': createHmac('sha256', config.secretKey).update(timestamp).digest('base64'),
  }
}

function endpoint(config: FacePhysConfig, path: string): string {
  const base = new URL(config.baseUrl)
  if (base.protocol !== 'https:') throw new Error('FACEPHYS_BASE_URL 必须使用 HTTPS。')
  return new URL(path, base).toString()
}

/** Match the official SDK's OSS path normalization without modifying its signed query. */
function uploadUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('FacePhys 未返回有效上传地址。')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('FacePhys 返回的上传地址不安全。')
  const queryStart = value.indexOf('?')
  const prefix = queryStart < 0 ? value : value.slice(0, queryStart)
  return prefix.replace(/%2F/gi, '/') + (queryStart < 0 ? '' : value.slice(queryStart))
}

function quality(sqi: number | null): SignalQuality {
  if (sqi === null) return 'unavailable'
  if (sqi >= 0.3) return 'good'
  if (sqi >= 0.15) return 'fair'
  return 'poor'
}

/** Exposes only non-diagnostic metrics used by the panel; never returns raw face video or psychological scores. */
export function mapFacePhysResponse(payload: unknown, observedAt = Date.now(), config = getFacePhysConfig()): FacePhysAnalysis {
  const root = record(payload)
  const data = record(root?.data)
  if (!data) throw new Error('FacePhys 未返回分析数据。')
  const cardiac = record(data.cardiac) || data
  const sqi = finite(cardiac.sqi) ?? finite(data.confidence)
  const entries = Array.isArray(cardiac.hr_list) ? cardiac.hr_list.map(record).filter((value): value is Record<string, unknown> => Boolean(value)) : []
  const heartRatePoints = entries.map(item => finite(item.hr)).filter((value): value is number => value !== null)
  const hasImplausibleJump = heartRatePoints.some((value, index) => index > 0 && Math.abs(value - heartRatePoints[index - 1]) > 15)
  // Reject weak signals, out-of-range estimates, and obvious segment artifacts.
  const usable = (sqi === null || sqi >= 0.15) && !hasImplausibleJump
  const validHr = finite(cardiac.hr)
  const hr = usable && validHr !== null && validHr >= 40 && validHr <= 180 ? validHr : null
  // The documented payload places breathing_rate under data; retain the older
  // cardiac.hrv fallback for compatible providers without fabricating a value.
  const breath = usable && (sqi === null || sqi >= 0.3)
    ? finite(data.breathing_rate) ?? finite(record(cardiac.hrv)?.breathing_rate)
    : null
  const duration = finite(root?.video_duration)
  const liveness = record(data.liveness)
  const livenessScore = finite(liveness?.liveness_score) ?? finite(liveness?.score)
  const isLive = typeof liveness?.is_live === 'boolean' ? liveness.is_live : null
  const commonMetrics = {
    ...(sqi === null ? {} : { signalQualityValue: sqi }),
    ...(livenessScore === null ? {} : { livenessScore }),
    ...(isLive === null ? {} : { isLive }),
    ...(breath === null ? {} : { respirationRate: breath }),
  }
  const lastOffset = Math.max(0, ...entries.map(item => finite(item.ts) ?? 0))
  const readings = entries.map(item => ({
    timestamp: observedAt - (lastOffset - (finite(item.ts) ?? lastOffset)) * 1000,
    source: 'api' as const,
    heartRateBpm: usable && finite(item.hr) !== null && Number(item.hr) >= 40 && Number(item.hr) <= 180 ? Number(item.hr) : null,
    emotion: null,
    signalQuality: hasImplausibleJump ? 'poor' as const : quality(sqi),
    ...(Object.keys(commonMetrics).length ? { extraMetrics: commonMetrics } : {}),
  }))
  if (!readings.length || readings.at(-1)?.heartRateBpm !== hr) {
    readings.push({
      timestamp: observedAt,
      source: 'api', heartRateBpm: hr, emotion: null, signalQuality: hasImplausibleJump ? 'poor' : quality(sqi),
      ...(Object.keys(commonMetrics).length ? { extraMetrics: commonMetrics } : {}),
    })
  }
  return { source: 'api', readings, rawData: safeAnalysisData(data, config), ...(duration === null ? {} : { videoDurationSeconds: duration }) }
}

/** Official three-step V3 flow: presign, PUT video, process. No automatic retries or hidden extra charges. */
export async function analyzeFacePhysVideo(
  video: Uint8Array,
  mimeType: string,
  config = getFacePhysConfig(),
  signal?: AbortSignal,
): Promise<FacePhysAnalysis> {
  if (!isFacePhysConfigured(config)) throw new Error('FACEPHYS_KEY_ID 或 FACEPHYS_SECRET_KEY 未设置。')
  if (!video.byteLength) throw new Error('视频内容为空。')
  if (!/^video\/(?:mp4|webm)(?:;|$)/i.test(mimeType)) throw new Error('仅支持 MP4 或 WebM 视频。')
  const presign = await fetch(endpoint(config, '/api/v2/video/upload/presign'), {
    method: 'POST', headers: { ...authHeaders(config), 'Content-Type': 'application/json', 'User-Agent': FACEPHYS_USER_AGENT },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  })
  const ticket = await readJson(presign, '预签名', config)
  if (typeof ticket.objectKey !== 'string' || !ticket.objectKey) throw new Error('FacePhys 未返回有效视频对象标识。')
  const uploaded = await fetch(uploadUrl(ticket.uploadUrl), {
    method: 'PUT',
    // The official JavaScript SDK signs and uploads with this fixed OSS Content-Type.
    headers: { 'Content-Type': 'video/mp4' },
    body: video as BodyInit,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
  })
  if (!uploaded.ok) throw new FacePhysError(uploaded.status, statusMessage(uploaded.status, '视频上传') + '。')
  const processed = await fetch(endpoint(config, '/api/v3/video/process'), {
    method: 'POST',
    headers: { ...authHeaders(config), 'Content-Type': 'application/json', 'User-Agent': FACEPHYS_USER_AGENT },
    body: JSON.stringify({ objectKey: ticket.objectKey, capability: 'rppg' }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  })
  return mapFacePhysResponse(await readJson(processed, '视频分析', config), Date.now(), config)
}
