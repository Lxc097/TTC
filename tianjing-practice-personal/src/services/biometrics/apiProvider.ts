import type {
  BiometricReading,
  BiometricsListener,
  BiometricsProvider,
  BiometricsStartOptions,
} from './types'

/** The documented FacePhys cloud API processes video clips, not individual live frames. */
const CAPTURE_SECONDS = 30
const MIN_CAPTURE_SECONDS = 15

function supportedMimeType(): string {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || ''
}

function abortError(): DOMException {
  return new DOMException('分析已取消。', 'AbortError')
}

export interface FacePhysRawBatch {
  capturedAt: string
  receivedAt: string
  videoDurationSeconds?: number
  rawData: Record<string, unknown>
}

function recordVideo(stream: MediaStream, signal: AbortSignal, setRecorder: (value: MediaRecorder | null) => void): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const mimeType = supportedMimeType()
    if (!mimeType) { reject(new Error('浏览器不支持 MP4 或 WebM 摄像头录制。')); return }
    let recorder: MediaRecorder
    // Match the provider's browser capture setting for a 720p / 30 fps source.
    try { recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_000_000 }) }
    catch { reject(new Error('无法启动摄像头片段采集。')); return }
    const chunks: BlobPart[] = []
    const startedAt = Date.now()
    let settled = false
    let timer = 0
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      recorder.removeEventListener('dataavailable', onData)
      recorder.removeEventListener('error', onError)
      recorder.removeEventListener('stop', onStop)
      setRecorder(null)
    }
    const fail = (message: string) => {
      if (settled) return
      settled = true
      if (recorder.state === 'recording') recorder.stop()
      cleanup()
      reject(new Error(message))
    }
    const onData = (event: BlobEvent) => { if (event.data.size) chunks.push(event.data) }
    const onError = () => fail('摄像头视频录制失败，请重新检测设备。')
    const onStop = () => {
      if (settled) return
      if (signal.aborted) { settled = true; cleanup(); reject(abortError()); return }
      if (Date.now() - startedAt < MIN_CAPTURE_SECONDS * 1000) {
        fail('采集不足 15 秒，无法发送 FacePhys 分析。')
        return
      }
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType })
      if (!blob.size) { fail('摄像头没有生成有效视频片段。'); return }
      settled = true
      cleanup()
      resolve(blob)
    }
    const onAbort = () => {
      if (settled) return
      if (recorder.state !== 'inactive') recorder.stop()
      settled = true
      cleanup()
      reject(abortError())
    }
    recorder.addEventListener('dataavailable', onData)
    recorder.addEventListener('error', onError)
    recorder.addEventListener('stop', onStop)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) { onAbort(); return }
    setRecorder(recorder)
    try {
      recorder.start()
      timer = window.setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop()
      }, CAPTURE_SECONDS * 1000)
    } catch { fail('无法启动摄像头片段采集。') }
  })
}

async function publicError(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: unknown }
    if (typeof data.error === 'string') return data.error
      .replace(/(?:sk-|ke)[A-Za-z0-9_-]{16,}/g, '[凭据已隐藏]')
      .slice(0, 240)
  } catch { /* Preserve the more useful HTTP status below. */ }
  return 'FacePhys 分析失败（HTTP ' + response.status + '）。'
}

export class ApiBiometricsProvider implements BiometricsProvider {
  readonly mode = 'api' as const
  private listeners = new Set<BiometricsListener>()
  private batchListeners = new Set<(batch: FacePhysRawBatch) => void>()
  private latest: BiometricReading | null = null
  private controller: AbortController | null = null
  private recorder: MediaRecorder | null = null
  private captureStartedAt: number | null = null
  private started = false

  async start({ consent, videoElement }: BiometricsStartOptions): Promise<void> {
    if (!consent) throw new Error('未获得图像分析授权，不会读取或发送摄像头画面。')
    if (this.started) return
    if (!videoElement?.srcObject || !(videoElement.srcObject instanceof MediaStream)) {
      throw new Error('请先开启摄像头，再开始 FacePhys 视频分析。')
    }
    const track = videoElement.srcObject.getVideoTracks()[0]
    if (!track || track.readyState !== 'live') throw new Error('摄像头视频轨道不可用。')
    if (typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持摄像头视频录制。')
    const controller = new AbortController()
    this.controller = controller
    this.started = true
    try {
      const statusResponse = await fetch('/api/biometrics/status', { signal: controller.signal })
      if (!statusResponse.ok) throw new Error(await publicError(statusResponse))
      const status = await statusResponse.json() as { configured?: unknown }
      if (status.configured !== true) throw new Error('FacePhys 服务端凭据未配置，本次仅生成回答内容报告。')
      // Borrow CameraManager's live track without owning or lowering its resolution.
      const capturedAt = new Date().toISOString()
      this.captureStartedAt = Date.now()
      let blob: Blob
      try { blob = await recordVideo(new MediaStream([track]), controller.signal, value => { this.recorder = value }) }
      finally { this.captureStartedAt = null }
      // FacePhys responds after batch processing. Anchor its time series to
      // capture completion, not to the later HTTP response time.
      const captureEndedAt = Date.now()
      const response = await fetch('/api/biometrics/analyze', {
        method: 'POST', headers: { 'Content-Type': blob.type }, body: blob, signal: controller.signal,
      })
      if (!response.ok) throw new Error(await publicError(response))
      const result = await response.json() as { source?: unknown; readings?: unknown; rawData?: unknown; videoDurationSeconds?: unknown }
      if (result.source !== 'api' || !Array.isArray(result.readings)) throw new Error('FacePhys 返回了无效数据。')
      if (result.rawData && typeof result.rawData === 'object' && !Array.isArray(result.rawData)) {
        const batch: FacePhysRawBatch = {
          capturedAt, receivedAt: new Date().toISOString(), rawData: result.rawData as Record<string, unknown>,
          ...(typeof result.videoDurationSeconds === 'number' && Number.isFinite(result.videoDurationSeconds)
            ? { videoDurationSeconds: result.videoDurationSeconds } : {}),
        }
        this.batchListeners.forEach(listener => listener(batch))
      }
      const validReadings = result.readings.filter((candidate): candidate is BiometricReading =>
        Boolean(candidate && typeof candidate === 'object' && candidate.source === 'api'
          && typeof candidate.timestamp === 'number' && Number.isFinite(candidate.timestamp)))
      const lastSampleAt = Math.max(...validReadings.map(reading => reading.timestamp))
      const responseDelay = Number.isFinite(lastSampleAt) ? lastSampleAt - captureEndedAt : 0
      for (const candidate of validReadings) {
        this.latest = { ...candidate, timestamp: candidate.timestamp - responseDelay }
        this.listeners.forEach(listener => listener(this.latest as BiometricReading))
      }
      if (!this.latest) throw new Error('FacePhys 没有返回可展示的生理指标。')
    } finally {
      if (this.controller === controller) {
        this.controller = null
        this.recorder = null
        this.captureStartedAt = null
        // The panel starts the next clip only after this batch has settled.
        this.started = false
      }
    }
  }

  stop(): void {
    this.controller?.abort()
    if (this.recorder?.state === 'recording') this.recorder.stop()
    this.controller = null
    this.recorder = null
    this.captureStartedAt = null
    this.started = false
  }

  getMinimumCaptureRemainingSeconds(): number | null {
    if (this.recorder?.state !== 'recording' || this.captureStartedAt === null) return null
    return Math.max(0, Math.ceil((MIN_CAPTURE_SECONDS * 1000 - (Date.now() - this.captureStartedAt)) / 1000))
  }

  /** Never upload a clip shorter than the provider's minimum; ending still releases the camera immediately. */
  finishCapture(): 'eligible' | 'short' | 'idle' {
    if (this.recorder?.state !== 'recording') return 'idle'
    if ((this.getMinimumCaptureRemainingSeconds() ?? 0) > 0) { this.stop(); return 'short' }
    this.recorder.stop()
    return 'eligible'
  }

  getLatestReading(): BiometricReading | null { return this.latest }
  subscribe(listener: BiometricsListener): void { this.listeners.add(listener) }
  unsubscribe(listener: BiometricsListener): void { this.listeners.delete(listener) }
  subscribeBatch(listener: (batch: FacePhysRawBatch) => void): void { this.batchListeners.add(listener) }
  unsubscribeBatch(listener: (batch: FacePhysRawBatch) => void): void { this.batchListeners.delete(listener) }
}
