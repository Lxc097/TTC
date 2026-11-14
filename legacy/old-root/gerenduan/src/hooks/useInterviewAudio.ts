import { useCallback, useEffect, useRef, useState } from 'react'

export type MicrophoneStatus = 'idle' | 'requesting' | 'ready' | 'denied' | 'unavailable' | 'error'
export type SpeechOutcome = 'ended' | 'cancelled' | 'error'

interface RecognitionAlternative { transcript: string }
interface RecognitionResult extends ArrayLike<RecognitionAlternative> { isFinal: boolean }
interface RecognitionEvent { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface RecognitionErrorEvent { error?: string }
interface BrowserRecognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: RecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognitionConstructor = new () => BrowserRecognition
type SpeechWindow = Window & {
  SpeechRecognition?: RecognitionConstructor
  webkitSpeechRecognition?: RecognitionConstructor
}

function recognitionConstructor(): RecognitionConstructor | undefined {
  if (typeof window === 'undefined') return undefined
  const target = window as SpeechWindow
  return target.SpeechRecognition || target.webkitSpeechRecognition
}

function microphoneError(error: unknown): { status: MicrophoneStatus; message: string } {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return { status: 'denied', message: '麦克风权限被拒绝。请在浏览器地址栏允许麦克风访问，或继续使用文字回答。' }
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { status: 'unavailable', message: '未找到可用麦克风。你仍可使用文字回答。' }
  }
  return { status: 'error', message: '麦克风启动失败。请检查设备是否被其他应用占用。' }
}

export function recognitionFailureMessage(code?: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed': return '浏览器未允许语音识别服务。请检查麦克风权限，或直接输入文字回答。'
    case 'audio-capture': return '语音识别未收到麦克风音频。请检查输入设备；文字回答仍可正常提交。'
    case 'network': return '浏览器语音识别服务连接失败。可直接输入文字回答。'
    case 'language-not-supported': return '浏览器语音识别不支持中文。请使用文字输入。'
    case 'no-speech': return '没有识别到有效语音。可以重试，或直接输入文字回答。'
    case 'aborted': return '语音识别已停止。可以直接输入文字回答。'
    default: return '语音识别暂时不可用。请使用文字输入，或检查浏览器与输入设备。'
  }
}

export function synthesisFailureMessage(code?: string): string {
  switch (code) {
    case 'not-allowed': return '浏览器阻止了自动朗读。请点击“重新朗读”重试，或直接阅读题目作答。'
    case 'audio-busy':
    case 'audio-hardware': return '无法使用当前扬声器。请检查系统输出设备；仍可阅读题目并文字作答。'
    case 'language-unavailable':
    case 'voice-unavailable': return '本机没有可用的中文朗读声音。请阅读题目并文字作答。'
    case 'network': return '浏览器朗读服务连接失败。请阅读题目并文字作答。'
    default: return '浏览器朗读失败。请阅读题目并文字作答。'
  }
}

export interface InterviewAudioOptions {
  onTranscript?: (text: string, isFinal: boolean) => void
  onRecognitionEnd?: () => void
  onRecognitionError?: (message: string) => void
  onVoiceActivity?: (active: boolean, level: number) => void
  onSpeechStart?: () => void
  onSpeechEnd?: (outcome: SpeechOutcome) => void
  onSpeechError?: (message: string) => void
}

/**
 * Browser audio lifecycle for the interview. Microphone samples are real RMS
 * readings from a MediaStream. Browser SpeechSynthesis audio cannot be routed
 * into Web Audio; a measurable TTS waveform requires an actual audio URL.
 */
export function useInterviewAudio(options: InterviewAudioOptions = {}) {
  const callbacks = useRef(options)
  callbacks.current = options
  const mounted = useRef(false)
  const requestId = useRef(0)
  const micStreamRef = useRef<MediaStream | null>(null)
  const micContextRef = useRef<AudioContext | null>(null)
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const micAnalyserRef = useRef<AnalyserNode | null>(null)
  const micFrameRef = useRef<number | null>(null)
  const micContextWarningTimerRef = useRef<number | null>(null)
  const micEndedRef = useRef<(() => void) | null>(null)
  const voiceActiveRef = useRef(false)
  const noiseFloorRef = useRef(0.008)
  const recognitionRef = useRef<BrowserRecognition | null>(null)
  const recognitionHintTimerRef = useRef<number | null>(null)
  const speechAudioRef = useRef<HTMLAudioElement | null>(null)
  const speechContextRef = useRef<AudioContext | null>(null)
  const speechSourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const speechAnalyserRef = useRef<AnalyserNode | null>(null)
  const speechCompletionRef = useRef<((outcome: SpeechOutcome) => void) | null>(null)
  const speechUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const speechStartTimerRef = useRef<number | null>(null)
  const speechRunRef = useRef(0)

  const [micStream, setMicStream] = useState<MediaStream | null>(null)
  const [micStatus, setMicStatus] = useState<MicrophoneStatus>('idle')
  const [micError, setMicError] = useState<string | null>(null)
  const [micAnalyser, setMicAnalyser] = useState<AnalyserNode | null>(null)
  const [micLevel, setMicLevel] = useState(0)
  const [voiceActive, setVoiceActive] = useState(false)
  const [isRecognizing, setIsRecognizing] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [ttsAnalyser, setTtsAnalyser] = useState<AnalyserNode | null>(null)
  const [speechError, setSpeechError] = useState<string | null>(null)
  const speechSupported = Boolean(recognitionConstructor())
  const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

  const closeMicrophoneGraph = useCallback(() => {
    if (micFrameRef.current !== null) cancelAnimationFrame(micFrameRef.current)
    micFrameRef.current = null
    if (micContextWarningTimerRef.current !== null) window.clearTimeout(micContextWarningTimerRef.current)
    micContextWarningTimerRef.current = null
    micSourceRef.current?.disconnect()
    micAnalyserRef.current?.disconnect()
    micSourceRef.current = null
    micAnalyserRef.current = null
    if (micContextRef.current) {
      micContextRef.current.onstatechange = null
      void micContextRef.current.close().catch(() => undefined)
    }
    micContextRef.current = null
  }, [])

  const stopMicrophone = useCallback(() => {
    requestId.current += 1
    const current = micStreamRef.current
    if (current && micEndedRef.current) current.getAudioTracks()[0]?.removeEventListener('ended', micEndedRef.current)
    micEndedRef.current = null
    current?.getTracks().forEach(track => track.stop())
    micStreamRef.current = null
    closeMicrophoneGraph()
    voiceActiveRef.current = false
    noiseFloorRef.current = 0.008
    if (mounted.current) {
      setMicStream(null)
      setMicAnalyser(null)
      setMicLevel(0)
      setVoiceActive(false)
      setMicStatus('idle')
      setMicError(null)
    }
  }, [closeMicrophoneGraph])

  const startMicrophone = useCallback(async (): Promise<boolean> => {
    if (micStreamRef.current?.getAudioTracks()[0]?.readyState === 'live') return true
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicStatus('unavailable')
      setMicError('当前环境无法访问麦克风。请在 localhost 或 HTTPS 下打开，或改用文字输入。')
      return false
    }
    const request = ++requestId.current
    setMicStatus('requesting')
    setMicError(null)
    let acquiredStream: MediaStream | null = null
    let acquiredContext: AudioContext | null = null
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      acquiredStream = stream
      if (!mounted.current || request !== requestId.current) {
        stream.getTracks().forEach(track => track.stop())
        return false
      }
      const context = new AudioContext()
      acquiredContext = context
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.7
      source.connect(analyser)
      micStreamRef.current = stream
      micContextRef.current = context
      micSourceRef.current = source
      micAnalyserRef.current = analyser
      context.onstatechange = () => {
        if (micContextRef.current !== context || context.state !== 'running') return
        if (micContextWarningTimerRef.current !== null) window.clearTimeout(micContextWarningTimerRef.current)
        micContextWarningTimerRef.current = null
        if (mounted.current) setMicError(null)
      }
      void context.resume().catch(() => undefined)
      micContextWarningTimerRef.current = window.setTimeout(() => {
        if (micContextRef.current === context && context.state !== 'running' && mounted.current) {
          setMicError('麦克风已连接，但浏览器尚未启动音量检测。请点击麦克风重试，或直接文字作答。')
        }
      }, 3_000)
      setMicStream(stream)
      setMicAnalyser(analyser)
      setMicStatus('ready')
      const samples = new Uint8Array(analyser.fftSize)
      let lastPaint = 0
      const sample = (now: number) => {
        if (micStreamRef.current !== stream) return
        if (now - lastPaint >= 70) {
          analyser.getByteTimeDomainData(samples)
          let squared = 0
          for (let i = 0; i < samples.length; i += 1) {
            const value = (samples[i] - 128) / 128
            squared += value * value
          }
          const rms = Math.sqrt(squared / samples.length)
          const level = Math.min(1, rms * 5)
          const active = rms > Math.max(0.024, noiseFloorRef.current * 2.2)
          if (!active) noiseFloorRef.current = noiseFloorRef.current * 0.96 + rms * 0.04
          if (active !== voiceActiveRef.current) {
            voiceActiveRef.current = active
            setVoiceActive(active)
          }
          setMicLevel(level)
          callbacks.current.onVoiceActivity?.(active, level)
          lastPaint = now
        }
        micFrameRef.current = requestAnimationFrame(sample)
      }
      micFrameRef.current = requestAnimationFrame(sample)
      const ended = () => {
        if (micStreamRef.current !== stream) return
        stopMicrophone()
        setMicStatus('unavailable')
        setMicError('麦克风连接已中断。请检查设备后重新开启，或使用文字输入。')
      }
      micEndedRef.current = ended
      stream.getAudioTracks()[0]?.addEventListener('ended', ended)
      return true
    } catch (error) {
      const isCurrentRequest = mounted.current && request === requestId.current
      if (acquiredStream && micStreamRef.current !== acquiredStream) acquiredStream.getTracks().forEach(track => track.stop())
      if (acquiredContext && micContextRef.current !== acquiredContext) void acquiredContext.close().catch(() => undefined)
      if (acquiredStream && micStreamRef.current === acquiredStream) stopMicrophone()
      if (!isCurrentRequest) return false
      const detail = microphoneError(error)
      setMicStatus(detail.status)
      setMicError(detail.message)
      return false
    }
  }, [stopMicrophone])

  const stopRecognition = useCallback(() => {
    if (recognitionHintTimerRef.current !== null) window.clearTimeout(recognitionHintTimerRef.current)
    recognitionHintTimerRef.current = null
    const current = recognitionRef.current
    recognitionRef.current = null
    if (current) {
      current.onstart = null
      current.onresult = null
      current.onerror = null
      current.onend = null
      try { current.stop() } catch { /* Already stopped. */ }
    }
    if (mounted.current) setIsRecognizing(false)
  }, [])

  const startRecognition = useCallback((): boolean => {
    if (recognitionRef.current) return true
    if (micStreamRef.current?.getAudioTracks()[0]?.readyState !== 'live') {
      callbacks.current.onRecognitionError?.('请先开启麦克风；也可以直接输入文字回答。')
      return false
    }
    const Constructor = recognitionConstructor()
    if (!Constructor) {
      callbacks.current.onRecognitionError?.('当前浏览器不支持语音转写，请使用文字输入。')
      return false
    }
    try {
      const recognition = new Constructor()
      recognition.lang = 'zh-CN'
      recognition.continuous = true
      recognition.interimResults = true
      recognition.onstart = () => {
        if (mounted.current) setIsRecognizing(true)
        recognitionHintTimerRef.current = window.setTimeout(() => {
          if (recognitionRef.current === recognition) callbacks.current.onRecognitionError?.('暂未收到可用语音转写。请检查输入设备，或直接输入文字回答。')
        }, 15_000)
      }
      recognition.onresult = event => {
        if (recognitionHintTimerRef.current !== null) window.clearTimeout(recognitionHintTimerRef.current)
        recognitionHintTimerRef.current = null
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index]
          const text = result?.[0]?.transcript?.trim()
          if (text) callbacks.current.onTranscript?.(text, Boolean(result.isFinal))
        }
      }
      recognition.onerror = event => {
        const message = recognitionFailureMessage(event.error)
        if (recognitionHintTimerRef.current !== null) window.clearTimeout(recognitionHintTimerRef.current)
        recognitionHintTimerRef.current = null
        if (recognitionRef.current === recognition) recognitionRef.current = null
        callbacks.current.onRecognitionError?.(message)
        if (mounted.current) setIsRecognizing(false)
      }
      recognition.onend = () => {
        if (recognitionRef.current !== recognition) return
        if (recognitionHintTimerRef.current !== null) window.clearTimeout(recognitionHintTimerRef.current)
        recognitionHintTimerRef.current = null
        recognitionRef.current = null
        if (mounted.current) setIsRecognizing(false)
        // Chrome may end a continuous recognition session after a pause or a
        // browser-side timeout. This is a normal lifecycle event, not an
        // error; only explicit recognition errors should show an alert.
        callbacks.current.onRecognitionEnd?.()
      }
      recognitionRef.current = recognition
      recognition.start()
      return true
    } catch {
      recognitionRef.current = null
      if (mounted.current) setIsRecognizing(false)
      callbacks.current.onRecognitionError?.('无法启动语音识别，请检查浏览器权限并使用文字输入。')
      return false
    }
  }, [])

  const finishSpeech = useCallback((outcome: SpeechOutcome) => {
    const complete = speechCompletionRef.current
    if (!complete) return
    speechCompletionRef.current = null
    if (speechStartTimerRef.current !== null) window.clearTimeout(speechStartTimerRef.current)
    speechStartTimerRef.current = null
    if (speechUtteranceRef.current) {
      speechUtteranceRef.current.onstart = null
      speechUtteranceRef.current.onend = null
      speechUtteranceRef.current.onerror = null
    }
    speechUtteranceRef.current = null
    const audio = speechAudioRef.current
    if (audio) {
      audio.onplay = null
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.removeAttribute('src')
      speechAudioRef.current = null
    }
    speechSourceRef.current?.disconnect()
    speechAnalyserRef.current?.disconnect()
    speechSourceRef.current = null
    speechAnalyserRef.current = null
    if (speechContextRef.current) void speechContextRef.current.close().catch(() => undefined)
    speechContextRef.current = null
    if (mounted.current) { setIsSpeaking(false); setTtsAnalyser(null) }
    callbacks.current.onSpeechEnd?.(outcome)
    complete(outcome)
  }, [])

  const stopSpeech = useCallback(() => {
    speechRunRef.current += 1
    finishSpeech('cancelled')
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel()
  }, [finishSpeech])

  const speak = useCallback((text: string, options?: { audioUrl?: string }): Promise<SpeechOutcome> => {
    stopSpeech()
    const run = ++speechRunRef.current
    setSpeechError(null)
    if (!text.trim()) return Promise.resolve('error')
    return new Promise<SpeechOutcome>(resolve => {
      speechCompletionRef.current = resolve
      const fail = (message: string) => {
        if (run !== speechRunRef.current || !speechCompletionRef.current) return
        setSpeechError(message)
        callbacks.current.onSpeechError?.(message)
        finishSpeech('error')
      }
      const started = () => {
        if (run !== speechRunRef.current) return
        if (speechStartTimerRef.current !== null) window.clearTimeout(speechStartTimerRef.current)
        speechStartTimerRef.current = null
        if (mounted.current) setIsSpeaking(true)
        callbacks.current.onSpeechStart?.()
      }
      const awaitStart = () => {
        speechStartTimerRef.current = window.setTimeout(() => {
          fail('浏览器没有开始播放朗读。请点击“重新朗读”重试，或直接阅读题目并文字作答。')
          window.speechSynthesis?.cancel()
        }, 6_000)
      }
      if (options?.audioUrl) {
        try {
          const audio = new Audio(options.audioUrl)
          audio.crossOrigin = 'anonymous'
          const context = new AudioContext()
          const source = context.createMediaElementSource(audio)
          const analyser = context.createAnalyser()
          analyser.fftSize = 1024
          source.connect(analyser)
          analyser.connect(context.destination)
          speechAudioRef.current = audio
          speechContextRef.current = context
          speechSourceRef.current = source
          speechAnalyserRef.current = analyser
          if (mounted.current) setTtsAnalyser(analyser)
          audio.onplay = started
          audio.onended = () => { if (run === speechRunRef.current) finishSpeech('ended') }
          audio.onerror = () => fail('语音音频播放失败，可阅读右侧问题并继续作答。')
          awaitStart()
          void Promise.all([context.resume(), audio.play()]).catch(() =>
            fail('浏览器阻止了语音播放，请点击重新朗读或继续文字作答。'))
        } catch {
          fail('无法创建语音播放通道，请继续文字作答。')
        }
        return
      }
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        fail('当前浏览器不支持问题朗读，可直接阅读题目并作答。')
        return
      }
      try {
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.lang = 'zh-CN'
        utterance.rate = 1
        utterance.pitch = 1
        utterance.volume = 1
        const selectChineseVoice = () => {
          const voices = window.speechSynthesis.getVoices()
          const chinese = voices.find(voice => /^zh(?:-CN)?$/i.test(voice.lang))
            || voices.find(voice => /^zh/i.test(voice.lang))
          if (chinese) utterance.voice = chinese
        }
        // Some Chromium builds populate voices asynchronously. Waiting briefly
        // avoids attempting a Chinese utterance before the voice list exists.
        selectChineseVoice()
        utterance.onstart = started
        utterance.onend = () => { if (run === speechRunRef.current) finishSpeech('ended') }
        utterance.onerror = event => fail(synthesisFailureMessage(event.error))
        speechUtteranceRef.current = utterance
        awaitStart()
        if (window.speechSynthesis.paused) window.speechSynthesis.resume()
        if (window.speechSynthesis.getVoices().length === 0) {
          let settled = false
          const onVoicesChanged = () => {
            if (settled || run !== speechRunRef.current) return
            settled = true
            window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged)
            selectChineseVoice()
            window.speechSynthesis.speak(utterance)
          }
          window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged, { once: true })
          window.setTimeout(() => {
            if (settled || run !== speechRunRef.current) return
            settled = true
            window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged)
            selectChineseVoice()
            window.speechSynthesis.speak(utterance)
          }, 700)
        } else window.speechSynthesis.speak(utterance)
      } catch {
        fail('无法启动浏览器朗读。请阅读右侧题目并文字作答。')
      }
    })
  }, [finishSpeech, stopSpeech])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      stopRecognition()
      stopSpeech()
      stopMicrophone()
    }
  }, [stopMicrophone, stopRecognition, stopSpeech])

  return {
    micStream, micStatus, micError, micLevel, voiceActive, micAnalyser,
    ttsAnalyser, speechError, isRecognizing, isSpeaking, speechSupported, ttsSupported,
    startMicrophone, stopMicrophone, startRecognition, stopRecognition, speak, stopSpeech,
  }
}
