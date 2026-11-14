import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCameraManager } from '../components/camera/CameraManager'
import { AIStage } from '../components/interview/room/AIStage'
import { ConfirmExitDialog } from '../components/interview/room/ConfirmExitDialog'
import { InterviewControlDock } from '../components/interview/room/InterviewControlDock'
import { InterviewHeader } from '../components/interview/room/InterviewHeader'
import { InterviewSidebar } from '../components/interview/room/InterviewSidebar'
import { useInterviewAudio } from '../hooks/useInterviewAudio'
import { INITIAL_INTERVIEW_FLOW, interviewFlowReducer, type InterviewFlowAction } from '../hooks/interviewFlow'
import { closeInterviewService, requestFollowUp, startInterviewService, summarizeAnswer, type InterviewServiceSession } from '../services/interviewClient'
import { ApiBiometricsProvider, type BiometricReading, type FacePhysRawBatch } from '../services/biometrics'
import { DEFAULT_INTERVIEW_CONFIG, ROLE_LABELS, type BiometricSample, type InterviewAnswer, type InterviewConfig, type InterviewQuestion, type InterviewRecord, type InterviewTranscriptEvent, type QuestionReaction } from '../types/interview'
import { describeQuestionReaction } from '../utils/answerInsight'
import { appendConfirmedTranscript, joinFinalTranscript, upsertFinalSegment } from '../utils/asrSegments'
import { shouldStartAutoSubmit } from '../utils/autoSubmit'
import { generateInterviewReport } from '../utils/report'
import { getInterviewRecord, saveInterviewRecord } from '../utils/storage'
import { correctTranscriptText } from '../utils/transcript'
import '../components/interview/room/room.css'

interface DeviceChoices { cameraEnabled: boolean; microphoneEnabled: boolean; consent: boolean; cameraDeviceId: string }
const DEFAULT_DEVICES: DeviceChoices = { cameraEnabled: false, microphoneEnabled: false, consent: false, cameraDeviceId: '' }

function getDraft(): InterviewConfig {
  try {
    const draft = JSON.parse(sessionStorage.getItem('yingda.draft') || 'null') as InterviewConfig | null
    if (!draft) return DEFAULT_INTERVIEW_CONFIG
    return { ...DEFAULT_INTERVIEW_CONFIG, ...draft, targetRole: draft.targetRole?.trim()
      || draft.targetRoleDescription?.trim() || ROLE_LABELS[draft.role] || '' }
  }
  catch { return DEFAULT_INTERVIEW_CONFIG }
}
function getDeviceChoices(): DeviceChoices {
  try { return { ...DEFAULT_DEVICES, ...JSON.parse(sessionStorage.getItem('yingda.devices') || 'null') } }
  catch { return DEFAULT_DEVICES }
}

function persistLateAnswerSummary(id: string, answers: InterviewAnswer[]): void {
  const saved = getInterviewRecord(id)
  if (!saved) return
  const updatedBase = { ...saved, answers }
  const updated: InterviewRecord = { ...updatedBase, report: generateInterviewReport(updatedBase) }
  try { saveInterviewRecord(updated) }
  catch { sessionStorage.setItem('yingda.unsaved-report', JSON.stringify(updated)) }
  window.dispatchEvent(new CustomEvent('interview-record-updated', { detail: id }))
}

export function InterviewSession() {
  const navigate = useNavigate()
  const config = useMemo(getDraft, [])
  const deviceChoices = useMemo(getDeviceChoices, [])
  const [questions, setQuestions] = useState<InterviewQuestion[]>([])
  const camera = useCameraManager()
  const [flow, reduceFlow] = useReducer(interviewFlowReducer, INITIAL_INTERVIEW_FLOW)
  const flowRef = useRef(INITIAL_INTERVIEW_FLOW)
  const dispatchFlow = useCallback((action: InterviewFlowAction) => {
    flowRef.current = interviewFlowReducer(flowRef.current, action)
    reduceFlow(action)
  }, [])
  const [answers, setAnswers] = useState<InterviewAnswer[]>([])
  const answersRef = useRef<InterviewAnswer[]>([])
  const [draft, setDraft] = useState('')
  const draftRef = useRef('')
  const [interim, setInterim] = useState('')
  const [inputMode, setInputMode] = useState<'text' | 'voice'>('text')
  const [elapsed, setElapsed] = useState(0)
  const [muted, setMuted] = useState(false)
  const mutedRef = useRef(false)
  const [autoSubmit, setAutoSubmit] = useState(false)
  const [countdown, setCountdown] = useState<number | null>(null)
  // Text is the reliable primary path when speech output or recognition is unavailable.
  const [textOpen, setTextOpen] = useState(true)
  const [confirmExit, setConfirmExit] = useState(false)
  const [notice, setNotice] = useState('')
  const [serviceMode, setServiceMode] = useState<InterviewServiceSession['mode']>('local')
  const [manualEditing, setManualEditing] = useState(false)
  const manualEditingRef = useRef(false)
  const editStartedAtRef = useRef(0)
  const [pendingTranscript, setPendingTranscript] = useState('')
  const pendingTranscriptRef = useRef('')
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null)
  const startAt = useRef(Date.now())
  const questionStartedAt = useRef(new Date().toISOString())
  const samplesRef = useRef<BiometricSample[]>([])
  const facephysBatchesStartedRef = useRef(0)
  const rawBatchesRef = useRef<FacePhysRawBatch[]>([])
  const biometricReadingsRef = useRef<BiometricReading[]>([])
  const transcriptEventsRef = useRef<InterviewTranscriptEvent[]>([])
  const liveReactionRef = useRef<QuestionReaction>(describeQuestionReaction(null))
  const biometricJobRef = useRef<{ provider: ApiBiometricsProvider; active: boolean; settled: boolean; error: string | null; promise: Promise<void> } | null>(null)
  const onReadingRef = useRef<(reading: BiometricReading) => void>(() => undefined)
  const sessionRef = useRef<InterviewServiceSession | null>(null)
  const finishedRecordIdRef = useRef<string | null>(null)
  const pendingAnswerWorkRef = useRef<Promise<void> | null>(null)
  const sessionCloseRequestedRef = useRef(false)
  const finishedRef = useRef(false)
  const submittedRoundRef = useRef('')
  const speechRunRef = useRef(0)
  const firstVoiceAt = useRef<number | null>(null)
  const lastVoiceAt = useRef<number | null>(null)
  const autoDeadline = useRef<number | null>(null)
  const autoCancelledRound = useRef(false)
  const submitRef = useRef<(skip?: boolean) => void>(() => undefined)
  const currentQuestion = questions[flow.index]
  const prompt = flow.followUpPrompt || currentQuestion?.prompt || ''
  const roundKey = String(flow.index) + ':' + String(flow.followUpCount)
  const remaining = Math.max(0, config.durationMinutes * 60 - elapsed)
  const maxFacephysBatches = config.durationMinutes === 5 ? 3 : config.durationMinutes === 10 ? 4 : 5
  const faceCaptureRemaining = deviceChoices.consent
    ? biometricJobRef.current?.provider.getMinimumCaptureRemainingSeconds() ?? null : null

  const setAnswerDraft = useCallback((text: string, source: 'text' | 'voice' = 'text') => {
    draftRef.current = text
    setDraft(text)
    setInputMode(source)
  }, [])
  const cancelCountdown = useCallback(() => {
    autoDeadline.current = null
    setCountdown(null)
  }, [])
  const resetVoiceTiming = useCallback(() => {
    firstVoiceAt.current = null
    lastVoiceAt.current = null
    autoCancelledRound.current = false
    cancelCountdown()
  }, [cancelCountdown])

  const requestSessionClose = useCallback(() => {
    const session = sessionRef.current
    if (!session || sessionCloseRequestedRef.current) return
    sessionCloseRequestedRef.current = true
    const pending = pendingAnswerWorkRef.current
    if (pending) void pending.then(() => closeInterviewService(session), () => closeInterviewService(session))
    else void closeInterviewService(session)
  }, [])

  const audio = useInterviewAudio({
    onTranscript: (text, isFinal, segmentId) => {
      if (flowRef.current.phase === 'completed') return
      const transcript = text.trim()
      if (!transcript) return
      if (!isFinal) { setInterim(transcript); return }
      const correction = correctTranscriptText(transcript)
      const event: InterviewTranscriptEvent = {
        segmentId, timestamp: new Date().toISOString(), rawText: transcript,
        correctedText: correction.correctedText, correctionNotes: correction.correctionNotes,
        isFinal: true, source: 'voice',
      }
      transcriptEventsRef.current = upsertFinalSegment(transcriptEventsRef.current, event)
      if (manualEditingRef.current) {
        const pending = joinFinalTranscript(transcriptEventsRef.current.filter(item => Date.parse(item.timestamp) >= editStartedAtRef.current))
        pendingTranscriptRef.current = pending
        setPendingTranscript(pending)
      } else setAnswerDraft(joinFinalTranscript(transcriptEventsRef.current), 'voice')
      setInterim('')
    },
    onRecognitionError: message => { setNotice(message); setInterim('') },
    onRecognitionEnd: () => setInterim(''),
    onVoiceActivity: active => {
      if (flowRef.current.phase !== 'listening' || !active) return
      const now = Date.now()
      if (firstVoiceAt.current === null) firstVoiceAt.current = now
      lastVoiceAt.current = now
      autoCancelledRound.current = false
      if (autoDeadline.current !== null) cancelCountdown()
    },
    onSpeechStart: () => dispatchFlow({ type: 'SPEECH_STARTED' }),
    onSpeechError: message => { setNotice(message); dispatchFlow({ type: 'ERROR', message }) },
  })
  const {
    startMicrophone, stopMicrophone, startRecognition, stopRecognition,
    speak, stopSpeech, micStatus, micError, micLevel, micAnalyser, ttsAnalyser,
    speechError, speechSupported, ttsSupported, isRecognizing,
  } = audio

  useEffect(() => {
    if (deviceChoices.cameraEnabled && camera.status !== 'ready') {
      void camera.start(deviceChoices.cameraDeviceId || undefined)
    }
  // A mounted route inherits the stream from device check; do not re-request on status updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let active = true
    void startInterviewService(config).then(session => {
      if (!active || finishedRef.current) {
        if (finishedRef.current) void closeInterviewService(session)
        return
      }
      sessionRef.current = session
      setServiceMode(session.mode)
      questionStartedAt.current = new Date().toISOString()
      setQuestions(session.questions)
      if (session.notice) setNotice(session.notice)
    })
    return () => { active = false; requestSessionClose() }
  }, [config, requestSessionClose])

  const beginListening = useCallback(async () => {
    if (finishedRef.current || !deviceChoices.microphoneEnabled) return
    const ready = await startMicrophone()
    if (finishedRef.current || !ready) return
    dispatchFlow({ type: 'LISTEN_STARTED' })
    if (speechSupported) startRecognition()
    else setNotice('当前浏览器不支持语音转写，可用文字回答；麦克风波形仍来自真实输入。')
  }, [deviceChoices.microphoneEnabled, dispatchFlow, speechSupported, startMicrophone, startRecognition])

  const playQuestion = useCallback((force = false) => {
    const run = ++speechRunRef.current
    stopRecognition()
    stopMicrophone()
    stopSpeech()
    dispatchFlow({ type: 'LISTEN_ENDED' })
    dispatchFlow({ type: 'CLEAR_ERROR' })
    resetVoiceTiming()
    setInterim('')
    if (!prompt || finishedRef.current) return
    if (mutedRef.current && !force) { void beginListening(); return }
    void speak(prompt).then(outcome => {
      if (run !== speechRunRef.current || finishedRef.current) return
      if (outcome === 'ended') {
        dispatchFlow({ type: 'SPEECH_ENDED' })
        void beginListening()
      } else if (outcome === 'error') {
        // Audio failure never blocks the visible question or manual answer path.
        dispatchFlow({ type: 'CLEAR_ERROR' })
        void beginListening()
      }
    }).catch(() => {
      if (run !== speechRunRef.current || finishedRef.current) return
      setNotice('浏览器朗读暂不可用。请阅读题目，直接输入文字回答。')
      dispatchFlow({ type: 'CLEAR_ERROR' })
      void beginListening()
    })
  }, [beginListening, dispatchFlow, prompt, resetVoiceTiming, speak, stopMicrophone, stopRecognition, stopSpeech])

  useEffect(() => {
    const emptyReaction = describeQuestionReaction(null)
    liveReactionRef.current = emptyReaction
    transcriptEventsRef.current = []
    manualEditingRef.current = false
    setManualEditing(false)
    editStartedAtRef.current = 0
    pendingTranscriptRef.current = ''
    setPendingTranscript('')
    draftRef.current = ''
    setDraft('')
    setInputMode('text')
    playQuestion()
    return () => { speechRunRef.current += 1; stopSpeech(); stopRecognition() }
  }, [roundKey, playQuestion, stopRecognition, stopSpeech])

  const finish = useCallback((finalAnswers?: InterviewAnswer[]) => {
    if (finishedRef.current) return
    finishedRef.current = true
    speechRunRef.current += 1
    dispatchFlow({ type: 'FINISH' })
    cancelCountdown()
    stopRecognition()
    stopSpeech()
    stopMicrophone()
    const biometricJob = biometricJobRef.current
    if (biometricJob) {
      biometricJob.active = false
      if (biometricJob.provider.finishCapture() === 'short' && !samplesRef.current.length && !rawBatchesRef.current.length)
        biometricJob.error = '本次画面采集不足 15 秒，未向 FacePhys 上传该片段。'
    }
    camera.stop()
    requestSessionClose()
    const base: Omit<InterviewRecord, 'report'> = {
      id: crypto.randomUUID(), config: { ...config, resumeText: undefined }, questions,
      startedAt: new Date(startAt.current).toISOString(), endedAt: new Date().toISOString(),
      elapsedSeconds: Math.min(config.durationMinutes * 60, Math.max(0, Math.floor((Date.now() - startAt.current) / 1000))),
      answers: finalAnswers || answersRef.current,
      biometrics: deviceChoices.consent ? {
        mode: 'api', samples: [...samplesRef.current], rawBatches: [...rawBatchesRef.current],
        status: biometricJob && !biometricJob.settled ? 'pending' : samplesRef.current.length || rawBatchesRef.current.length ? 'complete' : 'failed',
        ...(!biometricJob || (biometricJob.error && !rawBatchesRef.current.length)
          ? { error: biometricJob?.error || '未获取到 FacePhys 有效采样。' } : {}),
      } : undefined,
    }
    const record: InterviewRecord = { ...base, report: generateInterviewReport(base) }
    finishedRecordIdRef.current = record.id
    try { saveInterviewRecord(record) }
    catch { sessionStorage.setItem('yingda.unsaved-report', JSON.stringify(record)) }
    if (biometricJob && !biometricJob.settled) {
      void biometricJob.promise.then(() => {
        const saved = getInterviewRecord(record.id)
        if (!saved) return
        const updatedBase: Omit<InterviewRecord, 'report'> = {
          ...saved, answers: [...answersRef.current],
          biometrics: { mode: 'api', samples: [...samplesRef.current], rawBatches: [...rawBatchesRef.current],
            status: samplesRef.current.length || rawBatchesRef.current.length ? 'complete' : 'failed',
            ...(rawBatchesRef.current.length ? {} : biometricJob.error ? { error: biometricJob.error }
              : !samplesRef.current.length ? { error: '未获取到 FacePhys 有效采样。' } : {}),
          },
        }
        const updated: InterviewRecord = { ...updatedBase, report: generateInterviewReport(updatedBase) }
        try { saveInterviewRecord(updated) }
        catch { sessionStorage.setItem('yingda.unsaved-report', JSON.stringify(updated)) }
        window.dispatchEvent(new CustomEvent('interview-record-updated', { detail: record.id }))
      })
    }
    sessionStorage.setItem('yingda.draft', JSON.stringify({ ...config, resumeText: undefined }))
    navigate('/report/' + record.id, { replace: true })
  }, [camera, cancelCountdown, config, deviceChoices.consent, dispatchFlow, navigate, questions, requestSessionClose, stopMicrophone, stopRecognition, stopSpeech])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - startAt.current) / 1000)
      setElapsed(seconds)
      if (seconds >= config.durationMinutes * 60) finish()
    }, 500)
    return () => clearInterval(timer)
  }, [config.durationMinutes, finish])

  function commitAnswer(skip = false) {
    if (finishedRef.current || flowRef.current.phase === 'thinking') return
    const state = flowRef.current
    const question = questions[state.index]
    if (!question) return
    const key = String(state.index) + ':' + String(state.followUpCount)
    if (submittedRoundRef.current === key) return
    const text = skip ? '' : draftRef.current.trim()
    if (!skip && !text) { setTextOpen(true); return }
    submittedRoundRef.current = key
    speechRunRef.current += 1
    stopSpeech()
    stopRecognition()
    stopMicrophone()
    resetVoiceTiming()
    setInterim('')
    const answeredAt = new Date().toISOString()
    const isFollowUp = Boolean(state.followUpPrompt)
    const transcriptEvents = transcriptEventsRef.current.slice()
    if (!skip && text && (inputMode === 'text' || manualEditingRef.current)
      && text !== joinFinalTranscript(transcriptEvents)) {
      const correction = correctTranscriptText(text)
      transcriptEvents.push({
        timestamp: answeredAt, rawText: text, correctedText: correction.correctedText,
        correctionNotes: correction.correctionNotes, isFinal: true, source: 'text',
      })
    }
    const item: InterviewAnswer = {
      questionId: question.id + (isFollowUp ? '-followup-' + state.followUpCount : ''),
      roundKey: key,
      prompt: state.followUpPrompt || question.prompt, answer: text,
      startedAt: questionStartedAt.current, answeredAt,
      durationSeconds: Math.max(0, Math.round((Date.parse(answeredAt) - Date.parse(questionStartedAt.current)) / 1000)),
      inputMode: skip ? 'text' : inputMode, isFollowUp,
      reaction: liveReactionRef.current,
      transcriptEvents,
    }
    const next = [...answersRef.current, item]
    answersRef.current = next
    setAnswers(next)
    dispatchFlow({ type: 'SUBMIT_STARTED' })
    if (skip) {
      if (state.index + 1 >= questions.length) finish(next)
      else { questionStartedAt.current = new Date().toISOString(); dispatchFlow({ type: 'NEXT_QUESTION' }) }
      return
    }
    const session = sessionRef.current || { id: 'local-prep', mode: 'local' as const, config, questions }
    const summaryPromise = summarizeAnswer({ session, question, answer: text }).then(summary => {
      const withSummary = answersRef.current.map(candidate => candidate.roundKey === item.roundKey
        ? { ...candidate, aiSummary: summary.summary, aiSummarySource: summary.mode === 'siliconflow' ? 'deepseek' as const : 'local' as const }
        : candidate)
      answersRef.current = withSummary
      if (finishedRef.current) {
        if (finishedRecordIdRef.current) persistLateAnswerSummary(finishedRecordIdRef.current, withSummary)
      } else setAnswers(withSummary)
      return summary
    })
    const followUpPromise = requestFollowUp({ session, question, answer: text, followUpCount: state.followUpCount, previousPrompt: state.followUpPrompt || undefined })
    const pendingWork = Promise.all([summaryPromise, followUpPromise])
      .then(([summary, result]) => {
        if (finishedRef.current) return
        const withSummary = answersRef.current
        if (summary.notice) setNotice(summary.notice)
        if (session.mode === 'siliconflow' && result.mode === 'local') {
          // Future rounds must stay local after a remote failure: the proxy's count is no longer in sync.
          sessionRef.current = { ...session, mode: 'local' }
          void closeInterviewService(session)
        }
        setServiceMode(result.mode)
        if (result.notice && !(session.mode === 'local' && result.mode === 'local')) setNotice(result.notice)
        if (result.prompt) {
          questionStartedAt.current = new Date().toISOString()
          dispatchFlow({ type: 'FOLLOW_UP', prompt: result.prompt })
        } else if (state.index + 1 >= questions.length) finish(withSummary)
        else { questionStartedAt.current = new Date().toISOString(); dispatchFlow({ type: 'NEXT_QUESTION' }) }
      })
      .catch(() => {
        if (finishedRef.current) return
        setNotice('追问服务暂不可用，已进入下一题。')
        if (state.index + 1 >= questions.length) finish(answersRef.current)
        else { questionStartedAt.current = new Date().toISOString(); dispatchFlow({ type: 'NEXT_QUESTION' }) }
      })
    pendingAnswerWorkRef.current = pendingWork
    void pendingWork.then(() => {
      if (pendingAnswerWorkRef.current === pendingWork) pendingAnswerWorkRef.current = null
    })
  }
  submitRef.current = commitAnswer

  useEffect(() => {
    if (!autoSubmit) { cancelCountdown(); return }
    const interval = window.setInterval(() => {
      if (autoDeadline.current !== null) {
        const seconds = Math.max(0, Math.ceil((autoDeadline.current - Date.now()) / 1000))
        if (seconds === 0) { cancelCountdown(); submitRef.current() }
        else setCountdown(seconds)
      } else if (!autoCancelledRound.current && shouldStartAutoSubmit({
        enabled: autoSubmit, phase: flowRef.current.phase,
        firstVoiceAt: firstVoiceAt.current, lastVoiceAt: lastVoiceAt.current,
        now: Date.now(), hasText: Boolean(draftRef.current.trim()),
      })) {
        autoDeadline.current = Date.now() + 2000
        setCountdown(2)
      }
    }, 150)
    return () => clearInterval(interval)
  }, [autoSubmit, cancelCountdown])

  const toggleMicrophone = () => {
    if (micStatus === 'ready') {
      stopRecognition(); stopMicrophone(); setInterim(''); resetVoiceTiming(); dispatchFlow({ type: 'LISTEN_ENDED' })
    } else if (flowRef.current.phase === 'speaking') {
      setNotice('问题朗读结束后会自动收音。')
    } else {
      void startMicrophone().then(ready => {
        if (!ready || finishedRef.current) return
        dispatchFlow({ type: 'LISTEN_STARTED' })
        if (speechSupported) startRecognition()
        else setNotice('浏览器不支持语音转写，请在文字输入框中回答。')
      })
    }
  }
  const toggleMute = () => {
    const next = !mutedRef.current
    mutedRef.current = next
    setMuted(next)
    if (next && flowRef.current.phase === 'speaking') {
      speechRunRef.current += 1
      stopSpeech()
      dispatchFlow({ type: 'SPEECH_ENDED' })
      void beginListening()
    }
  }
  const onReading = (reading: BiometricReading) => {
    if (reading.source !== 'api') return
    const reaction = describeQuestionReaction(reading, biometricReadingsRef.current)
    biometricReadingsRef.current = [...biometricReadingsRef.current, reading]
    const readingTime = reading.timestamp
    if (readingTime >= Date.parse(questionStartedAt.current)) {
      liveReactionRef.current = reaction
    }
    const matchingAnswer = answersRef.current.find(answer => {
      const start = Date.parse(answer.startedAt)
      const end = Date.parse(answer.answeredAt)
      return Number.isFinite(start) && Number.isFinite(end) && readingTime >= start && readingTime <= end
    })
    const isCurrentRound = !finishedRef.current && readingTime >= Date.parse(questionStartedAt.current) && flowRef.current.phase !== 'thinking'
    const sampleQuestionId = matchingAnswer?.questionId.replace(/-followup(?:-\d+)?$/, '') || (isCurrentRound ? currentQuestion?.id : undefined)
    if (matchingAnswer) {
      const updatedAnswers = answersRef.current.map(answer => answer === matchingAnswer ? { ...answer, reaction } : answer)
      answersRef.current = updatedAnswers
      if (!finishedRef.current) setAnswers(updatedAnswers)
    }
    samplesRef.current = [...samplesRef.current, {
      timestamp: new Date(reading.timestamp).toISOString(), heartRateBpm: reading.heartRateBpm ?? undefined,
      emotion: reading.emotion?.label,
      emotionConfidence: reading.emotion?.confidence,
      signalQuality: reading.signalQuality, questionId: sampleQuestionId, roundKey: matchingAnswer?.roundKey || (isCurrentRound ? roundKey : undefined), reaction,
    }]
  }
  onReadingRef.current = onReading

  useEffect(() => {
    if (!deviceChoices.consent || !videoElement || !camera.stream) return
    const provider = new ApiBiometricsProvider()
    const listener = (reading: BiometricReading) => onReadingRef.current(reading)
    const batchListener = (batch: FacePhysRawBatch) => { rawBatchesRef.current = [...rawBatchesRef.current, batch] }
    provider.subscribe(listener)
    provider.subscribeBatch(batchListener)
    const job: NonNullable<typeof biometricJobRef.current> = {
      provider, active: true, settled: false, error: null, promise: Promise.resolve(),
    }
    biometricJobRef.current = job
    job.promise = (async () => {
      try {
        while (job.active && !finishedRef.current && facephysBatchesStartedRef.current < maxFacephysBatches) {
          facephysBatchesStartedRef.current += 1
          await provider.start({ consent: true, videoElement })
        }
        if (job.active && !finishedRef.current && facephysBatchesStartedRef.current >= maxFacephysBatches)
          setNotice('FacePhys 本场最多分析 ' + maxFacephysBatches + ' 段，已停止上传新视频；摄像头预览仍可使用。')
      } catch (error) {
        if (job.active || finishedRef.current) {
          job.error ||= error instanceof Error ? error.message : 'FacePhys 分析未返回有效结果。'
        }
      } finally {
        job.settled = true
        provider.unsubscribe(listener)
        provider.unsubscribeBatch(batchListener)
      }
    })()
    return () => {
      job.active = false
      if (!finishedRef.current) provider.stop()
      if (biometricJobRef.current === job) biometricJobRef.current = null
    }
  }, [camera.stream, deviceChoices.consent, maxFacephysBatches, videoElement])

  if (!questions.length) return <div className="room-page"><div className="room-loading" role="status"><span className="section-kicker">正在准备</span><h1>正在为你生成面试题</h1><p>DeepSeek 会结合目标岗位与简历内容出题；服务暂不可用时将自动使用本地题库。</p></div></div>

  const visibleNotices = Array.from(new Set([camera.error, micError, speechError, notice].filter(Boolean)))

  return <div className="room-page">
    <InterviewHeader config={config} phase={flow.phase} remaining={remaining} number={Math.min(flow.index + 1, questions.length)} total={questions.length} />
    <div className="room-progress" aria-label="面试进度"><span style={{ width: Math.min(100, (flow.index + (flow.followUpPrompt ? 0.5 : 0)) / questions.length * 100) + '%' }} /></div>
    <div className="room-workspace">
      <AIStage phase={flow.phase} prompt={prompt} number={flow.index + 1} total={questions.length} ttsAnalyser={ttsAnalyser} micAnalyser={micAnalyser} onReplay={() => playQuestion(true)} onVideoElement={setVideoElement} />
      <InterviewSidebar number={flow.index + 1} total={questions.length} prompt={prompt} isFollowUp={Boolean(flow.followUpPrompt)} answers={answers} draft={draft} interim={interim} cameraStatus={camera.status} micStatus={micStatus} micLevel={micLevel} notice={visibleNotices.join(' ')} reaction={liveReactionRef.current} onDraftChange={text => { if (!manualEditingRef.current) { manualEditingRef.current = true; editStartedAtRef.current = Date.now(); setManualEditing(true) } setAnswerDraft(text, 'text') }} onEditFocus={() => { if (!manualEditingRef.current) { manualEditingRef.current = true; editStartedAtRef.current = Date.now(); setManualEditing(true) } }} manualEditing={manualEditing} pendingTranscript={pendingTranscript} onMergeTranscript={() => { setAnswerDraft(appendConfirmedTranscript(draftRef.current, pendingTranscriptRef.current), 'text'); pendingTranscriptRef.current = ''; setPendingTranscript(''); editStartedAtRef.current = Date.now() }} />
    </div>
    <div className="room-service-line" role="status">{serviceMode === 'siliconflow' ? '硅基流动 · DeepSeek 个性化出题与动态追问' : '本地题库与规则追问 · 离线回退'} · {ttsSupported ? '浏览器朗读可尝试' : '文字题目'} · {speechSupported ? (isRecognizing ? '浏览器转写已启动' : '浏览器转写可尝试') : '语音转写不可用'} · 文字回答始终可用</div>
    <InterviewControlDock phase={flow.phase} micOn={micStatus === 'ready'} cameraOn={camera.status === 'ready'} muted={muted} autoSubmit={autoSubmit} countdown={countdown} draft={draft} textOpen={textOpen} busy={flow.phase === 'thinking' || flow.phase === 'completed'} onToggleMic={toggleMicrophone} onToggleCamera={() => camera.status === 'ready' ? camera.stop() : void camera.start()} onToggleMute={toggleMute} onAutoSubmitChange={enabled => { setAutoSubmit(enabled); if (enabled) autoCancelledRound.current = false; else cancelCountdown() }} onTextOpenChange={setTextOpen} onDraftChange={text => setAnswerDraft(text, 'text')} onSubmit={() => commitAnswer()} onSkip={() => commitAnswer(true)} onSkipSpeech={() => { speechRunRef.current += 1; stopSpeech(); dispatchFlow({ type: 'SPEECH_ENDED' }); void beginListening() }} onCancelCountdown={() => { autoCancelledRound.current = true; cancelCountdown() }} onExit={() => setConfirmExit(true)} />
    <ConfirmExitDialog open={confirmExit} faceCaptureRemainingSeconds={faceCaptureRemaining} onCancel={() => setConfirmExit(false)} onConfirm={() => finish()} />
  </div>
}
