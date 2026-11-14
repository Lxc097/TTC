import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import BiometricsPanel from '../components/analytics/BiometricsPanel'
import { useCameraManager } from '../components/camera/CameraManager'
import { AIStage } from '../components/interview/room/AIStage'
import { ConfirmExitDialog } from '../components/interview/room/ConfirmExitDialog'
import { InterviewControlDock } from '../components/interview/room/InterviewControlDock'
import { InterviewHeader } from '../components/interview/room/InterviewHeader'
import { InterviewSidebar } from '../components/interview/room/InterviewSidebar'
import { useInterviewAudio } from '../hooks/useInterviewAudio'
import { INITIAL_INTERVIEW_FLOW, interviewFlowReducer, type InterviewFlowAction } from '../hooks/interviewFlow'
import { closeInterviewService, requestFollowUp, startInterviewService, summarizeAnswer, type InterviewServiceSession } from '../services/interviewClient'
import type { BiometricReading, BiometricsMode } from '../services/biometrics'
import { DEFAULT_INTERVIEW_CONFIG, type BiometricSample, type InterviewAnswer, type InterviewConfig, type InterviewQuestion, type InterviewRecord, type QuestionReaction } from '../types/interview'
import { describeQuestionReaction } from '../utils/answerInsight'
import { shouldStartAutoSubmit } from '../utils/autoSubmit'
import { generateInterviewReport } from '../utils/report'
import { saveInterviewRecord } from '../utils/storage'
import { completeFormalInterview, getFormalContext, saveFormalAnswer } from '../services/formalInterview'
import '../components/interview/room/room.css'

interface DeviceChoices { cameraEnabled: boolean; microphoneEnabled: boolean; consent: boolean; cameraDeviceId: string }
const DEFAULT_DEVICES: DeviceChoices = { cameraEnabled: false, microphoneEnabled: false, consent: false, cameraDeviceId: '' }

function getDraft(): InterviewConfig {
  try { return JSON.parse(sessionStorage.getItem('yingda.draft') || 'null') || DEFAULT_INTERVIEW_CONFIG }
  catch { return DEFAULT_INTERVIEW_CONFIG }
}
function getDeviceChoices(): DeviceChoices {
  try { return { ...DEFAULT_DEVICES, ...JSON.parse(sessionStorage.getItem('yingda.devices') || 'null') } }
  catch { return DEFAULT_DEVICES }
}

export function InterviewSession() {
  const navigate = useNavigate()
  const config = useMemo(getDraft, [])
  const formal = useMemo(getFormalContext, [])
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
  const [fatal, setFatal] = useState('')
  const [completionError, setCompletionError] = useState('')
  const [serviceMode, setServiceMode] = useState<InterviewServiceSession['mode']>('local')
  const [bioMode, setBioMode] = useState<BiometricsMode>('mock')
  const [liveReaction, setLiveReaction] = useState<QuestionReaction>(() => describeQuestionReaction(null))
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null)
  const startAt = useRef(Date.now())
  const questionStartedAt = useRef(new Date().toISOString())
  const samplesRef = useRef<BiometricSample[]>([])
  const liveReactionRef = useRef<QuestionReaction>(describeQuestionReaction(null))
  const modeRef = useRef<BiometricsMode>('mock')
  const sessionRef = useRef<InterviewServiceSession | null>(null)
  const finishedRef = useRef(false)
  const completionPendingRef = useRef(false)
  const completionBlockedRef = useRef(false)
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

  const audio = useInterviewAudio({
    onTranscript: (text, isFinal) => {
      if (flowRef.current.phase === 'completed') return
      if (isFinal) {
        const next = [draftRef.current.trim(), text].filter(Boolean).join(' ')
        setAnswerDraft(next, 'voice')
        setInterim('')
      } else setInterim(text)
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
    void startInterviewService(config, formal || undefined).then(session => {
      if (!active || finishedRef.current) return
      sessionRef.current = session
      if (formal) startAt.current = Date.now()
      setServiceMode(session.mode)
      setQuestions(session.questions)
      if (session.notice) setNotice(session.notice)
    }).catch(error => {
      if (active) setFatal(error instanceof Error ? error.message : '无法连接真实 AI 初面服务。')
    })
    return () => { active = false; void closeInterviewService(sessionRef.current) }
  }, [config, formal])

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
    setLiveReaction(emptyReaction)
    playQuestion()
    return () => { speechRunRef.current += 1; stopSpeech(); stopRecognition() }
  }, [roundKey, playQuestion, stopRecognition, stopSpeech])

  const finish = useCallback(async (finalAnswers?: InterviewAnswer[], retry = false) => {
    if (finishedRef.current || completionPendingRef.current || (completionBlockedRef.current && !retry)) return
    completionPendingRef.current = true
    speechRunRef.current += 1
    cancelCountdown()
    stopRecognition()
    stopSpeech()
    stopMicrophone()
    camera.stop()
    if (formal) {
      try {
        const baseAnswers = (finalAnswers || answersRef.current).filter(item => !item.isFollowUp && item.answer.trim())
        for (const item of baseAnswers) await saveFormalAnswer(formal, item)
        await completeFormalInterview(formal)
      } catch (error) {
        completionBlockedRef.current = true
        completionPendingRef.current = false
        setCompletionError(error instanceof Error ? error.message : '面试回答暂未保存，请检查网络后重试。')
        return
      }
    }
    finishedRef.current = true
    dispatchFlow({ type: 'FINISH' })
    void closeInterviewService(sessionRef.current)
    const base: Omit<InterviewRecord, 'report'> = {
      id: crypto.randomUUID(), formalApplicationId: formal?.applicationId,
      config: { ...config, resumeText: undefined }, questions,
      startedAt: new Date(startAt.current).toISOString(), endedAt: new Date().toISOString(),
      elapsedSeconds: Math.min(config.durationMinutes * 60, Math.max(0, Math.floor((Date.now() - startAt.current) / 1000))),
      answers: finalAnswers || answersRef.current,
      biometrics: deviceChoices.consent ? { mode: modeRef.current, samples: samplesRef.current } : undefined,
    }
    const record: InterviewRecord = { ...base, report: generateInterviewReport(base) }
    try { saveInterviewRecord(record) }
    catch { sessionStorage.setItem('yingda.unsaved-report', JSON.stringify(record)) }
    sessionStorage.setItem('yingda.draft', JSON.stringify({ ...config, resumeText: undefined }))
    navigate('/report/' + record.id, { replace: true })
  }, [camera, cancelCountdown, config, deviceChoices.consent, dispatchFlow, formal, navigate, questions, stopMicrophone, stopRecognition, stopSpeech])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - startAt.current) / 1000)
      setElapsed(seconds)
      if (seconds >= config.durationMinutes * 60) void finish()
    }, 500)
    return () => clearInterval(timer)
  }, [config.durationMinutes, finish])

  function commitAnswer(skip = false) {
    if (finishedRef.current || flowRef.current.phase === 'thinking') return
    const state = flowRef.current
    const question = questions[state.index]
    if (!question) return
    if (formal && skip && !state.followUpPrompt) {
      setNotice('正式初面需要回答每道主问题；请根据真实经历作答。')
      return
    }
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
    const item: InterviewAnswer = {
      questionId: question.id + (isFollowUp ? '-followup-' + state.followUpCount : ''),
      prompt: state.followUpPrompt || question.prompt, answer: text,
      startedAt: questionStartedAt.current, answeredAt,
      durationSeconds: Math.max(0, Math.round((Date.parse(answeredAt) - Date.parse(questionStartedAt.current)) / 1000)),
      inputMode: skip ? 'text' : inputMode, isFollowUp,
      reaction: liveReactionRef.current,
    }
    const next = [...answersRef.current, item]
    answersRef.current = next
    setAnswers(next)
    if (formal && !isFollowUp && !skip) {
      void saveFormalAnswer(formal, item).catch(() => setNotice('本题暂未同步，提交面试时会自动重试保存。'))
    }
    setAnswerDraft('')
    dispatchFlow({ type: 'SUBMIT_STARTED' })
    if (skip) {
      if (state.index + 1 >= questions.length) void finish(next)
      else { questionStartedAt.current = new Date().toISOString(); dispatchFlow({ type: 'NEXT_QUESTION' }) }
      return
    }
    const session = sessionRef.current || { id: 'local-prep', mode: 'local' as const, config, questions }
    const summaryPromise = summarizeAnswer({ session, question, answer: text })
    const followUpPromise = requestFollowUp({ session, question, answer: text, followUpCount: state.followUpCount, previousPrompt: state.followUpPrompt || undefined })
    void Promise.all([summaryPromise, followUpPromise])
      .then(([summary, result]) => {
        if (finishedRef.current) return
        const completedItem = { ...item, aiSummary: summary.summary, aiSummarySource: summary.mode === 'siliconflow' ? 'deepseek' as const : 'local' as const }
        const withSummary = answersRef.current.map(candidate => candidate === item ? completedItem : candidate)
        answersRef.current = withSummary
        setAnswers(withSummary)
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
        } else if (state.index + 1 >= questions.length) void finish(withSummary)
        else { questionStartedAt.current = new Date().toISOString(); dispatchFlow({ type: 'NEXT_QUESTION' }) }
      })
      .catch(() => {
        if (finishedRef.current) return
        setNotice('追问服务暂不可用，已进入下一题。')
        if (state.index + 1 >= questions.length) void finish(answersRef.current)
        else { questionStartedAt.current = new Date().toISOString(); dispatchFlow({ type: 'NEXT_QUESTION' }) }
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
    const reaction = describeQuestionReaction(reading)
    liveReactionRef.current = reaction
    setLiveReaction(reaction)
    samplesRef.current = [...samplesRef.current.slice(-499), {
      timestamp: new Date(reading.timestamp).toISOString(), heartRateBpm: reading.heartRateBpm ?? undefined,
      emotion: reading.source === 'mock' ? reading.emotion?.label : undefined,
      emotionConfidence: reading.source === 'mock' ? reading.emotion?.confidence : undefined,
      signalQuality: reading.signalQuality, questionId: currentQuestion?.id, roundKey, reaction,
    }]
  }
  const onModeChange = (mode: BiometricsMode) => {
    setBioMode(mode); modeRef.current = mode; samplesRef.current = []
  }

  if (fatal) return <div className="room-page"><div className="room-loading" role="alert"><span className="section-kicker">真实 AI 初面</span><h1>暂时无法开始</h1><p>{fatal}</p><a className="button button-primary" href={import.meta.env.BASE_URL + '?application=' + encodeURIComponent(formal?.applicationId || '')}>返回邀请重试</a></div></div>
  if (completionError) return <div className="room-page"><div className="room-loading" role="alert"><span className="section-kicker">提交未完成</span><h1>面试记录尚未确认</h1><p>{completionError}</p><button className="button button-primary" onClick={() => { setCompletionError(''); void finish(undefined, true) }}>重试提交</button><a className="button button-secondary" href="/personal/applications.html">返回我的申请</a></div></div>
  if (!questions.length) return <div className="room-page"><div className="room-loading" role="status"><span className="section-kicker">正在准备</span><h1>正在为你生成面试题</h1><p>{formal ? '正在由 DeepSeek 生成岗位面试题；服务不可用时不会改用演示题库。' : 'DeepSeek 会结合目标岗位与简历内容出题；服务暂不可用时将自动使用本地题库。'}</p></div></div>

  const visibleNotices = Array.from(new Set([camera.error, micError, speechError, notice].filter(Boolean)))

  return <div className="room-page">
    <InterviewHeader config={config} formal={Boolean(formal)} phase={flow.phase} remaining={remaining} number={Math.min(flow.index + 1, questions.length)} total={questions.length} />
    <div className="room-progress" aria-label="面试进度"><span style={{ width: Math.min(100, (flow.index + (flow.followUpPrompt ? 0.5 : 0)) / questions.length * 100) + '%' }} /></div>
    <div className="room-workspace">
      <AIStage phase={flow.phase} prompt={prompt} number={flow.index + 1} ttsAnalyser={ttsAnalyser} micAnalyser={micAnalyser} onReplay={() => playQuestion(true)} onVideoElement={setVideoElement} />
      <InterviewSidebar number={flow.index + 1} total={questions.length} prompt={prompt} isFollowUp={Boolean(flow.followUpPrompt)} answers={answers} draft={draft} interim={interim} cameraStatus={camera.status} micStatus={micStatus} micLevel={micLevel} notice={visibleNotices.join(' ')} reaction={liveReaction} showBiometrics={!formal} />
    </div>
    <div className="room-service-line" role="status">{formal ? '岗位 AI 初面 · 硅基流动 DeepSeek 出题' : serviceMode === 'siliconflow' ? '硅基流动 · DeepSeek 个性化出题与动态追问' : '本地题库与规则追问 · 演示模式'} · {ttsSupported ? '浏览器朗读可尝试' : '文字题目'} · {speechSupported ? (isRecognizing ? '浏览器转写已启动' : '浏览器转写可尝试') : '语音转写不可用'} · 文字回答始终可用</div>
    {!formal && <details className="room-bio"><summary>生理信号观察 {bioMode === 'mock' ? '· 演示数据' : '· FacePhys 分段分析'}</summary><BiometricsPanel mode={bioMode} consent={deviceChoices.consent} videoElement={videoElement} onReading={onReading} onModeChange={onModeChange} /></details>}
    <InterviewControlDock phase={flow.phase} micOn={micStatus === 'ready'} cameraOn={camera.status === 'ready'} muted={muted} autoSubmit={autoSubmit} countdown={countdown} draft={draft} textOpen={textOpen} busy={flow.phase === 'thinking' || flow.phase === 'completed'} allowSkip={!formal || Boolean(flow.followUpPrompt)} onToggleMic={toggleMicrophone} onToggleCamera={() => camera.status === 'ready' ? camera.stop() : void camera.start()} onToggleMute={toggleMute} onAutoSubmitChange={enabled => { setAutoSubmit(enabled); if (enabled) autoCancelledRound.current = false; else cancelCountdown() }} onTextOpenChange={setTextOpen} onDraftChange={text => setAnswerDraft(text, 'text')} onSubmit={() => commitAnswer()} onSkip={() => commitAnswer(true)} onCancelCountdown={() => { autoCancelledRound.current = true; cancelCountdown() }} onExit={() => setConfirmExit(true)} />
    <ConfirmExitDialog open={confirmExit} onCancel={() => setConfirmExit(false)} onConfirm={() => void finish()} />
  </div>
}
