import { useEffect, useRef, useState } from 'react'
import { Activity, HeartPulse, ShieldCheck } from 'lucide-react'
import { estimatePulseBpm, pulseWaveformPath, type PulseSample } from '../../utils/ppg'
import './live-pulse.css'

interface LivePulsePanelProps {
  videoElement: HTMLVideoElement | null
  cameraReady: boolean
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
}

export const PULSE_CONTINUE_KEY = 'skylens.pulseContinue'

type SignalState = 'waiting' | 'collecting' | 'weak' | 'ready' | 'unavailable'

function sampleOpticalSignal(video: HTMLVideoElement, context: CanvasRenderingContext2D): number | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return null
  context.drawImage(video, 0, 0, 64, 64)
  // The central upper frame is a small face-oriented region, not a separate capture.
  const pixels = context.getImageData(16, 8, 32, 32).data
  let red = 0
  let green = 0
  let blue = 0
  const count = pixels.length / 4
  for (let index = 0; index < pixels.length; index += 4) {
    red += pixels[index]
    green += pixels[index + 1]
    blue += pixels[index + 2]
  }
  red /= count
  green /= count
  blue /= count
  const brightness = (red + green + blue) / 3
  if (brightness < 35 || brightness > 225) return null
  return (green - (red + blue) / 2) / Math.max(1, red + green + blue)
}

/** The preview's existing MediaStream is sampled locally only while explicitly enabled. */
export function LivePulsePanel({ videoElement, cameraReady, enabled, onEnabledChange }: LivePulsePanelProps) {
  const [points, setPoints] = useState<PulseSample[]>([])
  const [bpm, setBpm] = useState<number | null>(null)
  const [signal, setSignal] = useState<SignalState>('waiting')
  const bufferRef = useRef<PulseSample[]>([])

  useEffect(() => {
    if (!enabled || !cameraReady || !videoElement) return
    const track = (videoElement.srcObject as MediaStream | null)?.getVideoTracks()[0]
    if (!track || track.readyState !== 'live') return
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return

    let stopped = false
    let videoFrameId: number | null = null
    let animationFrameId: number | null = null
    let lastSampleAt = 0
    let lastValue: number | null = null
    let lastEstimateAt = 0
    let estimates: number[] = []
    bufferRef.current = []

    const reset = () => {
      bufferRef.current = []
      lastValue = null
      estimates = []
      setPoints([])
      setBpm(null)
      setSignal('waiting')
    }
    const onVisibility = () => { if (document.visibilityState !== 'visible') reset() }
    document.addEventListener('visibilitychange', onVisibility)

    const schedule = () => {
      if (stopped) return
      if (typeof videoElement.requestVideoFrameCallback === 'function') {
        videoFrameId = videoElement.requestVideoFrameCallback(frame)
      } else {
        animationFrameId = window.requestAnimationFrame(frame)
      }
    }
    const frame = (now: number) => {
      if (stopped) return
      if (track.readyState !== 'live' || document.visibilityState !== 'visible') {
        if (track.readyState !== 'live') reset()
        schedule()
        return
      }
      // Cap canvas reads near 15 Hz even when the camera renders at 30/60 fps.
      if (now - lastSampleAt >= 65) {
        lastSampleAt = now
        try {
          const value = sampleOpticalSignal(videoElement, context)
          if (value === null) {
            reset()
          } else {
            const previous = bufferRef.current.at(-1)
            if ((previous && now - previous.at > 450) || (lastValue !== null && Math.abs(value - lastValue) > 0.018)) reset()
            lastValue = value
            const next = [...bufferRef.current, { at: now, value }].filter(item => item.at >= now - 20_000)
            bufferRef.current = next
            setPoints(next)
            if (next.at(-1)!.at - next[0].at < 15_000) setSignal('collecting')
            if (now - lastEstimateAt >= 1_000) {
              lastEstimateAt = now
              const estimate = estimatePulseBpm(next)
              if (estimate === null) {
                estimates = []
                setBpm(null)
                if (next.at(-1)!.at - next[0].at >= 15_000) setSignal('weak')
              } else {
                estimates = [...estimates.slice(-2), estimate]
                if (estimates.length === 3 && Math.max(...estimates) - Math.min(...estimates) <= 8) {
                  setBpm(Math.round(estimates.reduce((sum, item) => sum + item, 0) / estimates.length))
                  setSignal('ready')
                } else {
                  setBpm(null)
                  setSignal('weak')
                }
              }
            }
          }
        } catch {
          reset()
          setSignal('unavailable')
        }
      }
      schedule()
    }
    schedule()
    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', onVisibility)
      if (videoFrameId !== null && typeof videoElement.cancelVideoFrameCallback === 'function') videoElement.cancelVideoFrameCallback(videoFrameId)
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId)
      bufferRef.current = []
      // CameraManager owns the video track. Never stop it from this optional panel.
    }
  }, [cameraReady, enabled, videoElement])

  const toggle = (next: boolean) => {
    bufferRef.current = []
    setPoints([])
    setBpm(null)
    setSignal('waiting')
    onEnabledChange(next)
  }
  const status = !enabled ? '已关闭' : !cameraReady ? '等待摄像头' : !videoElement ? '等待画面' :
    signal === 'ready' ? '信号可用' : signal === 'collecting' ? '采集中 · 约需 15 秒' :
    signal === 'weak' ? '信号不足 · 请保持稳定' : signal === 'unavailable' ? '画面暂不可读取' : '等待信号'
  const displayPoints = enabled && cameraReady && videoElement ? points : []
  const displayBpm = enabled && cameraReady && videoElement && signal === 'ready' ? bpm : null

  return <section className={'pulse-panel' + (enabled ? ' pulse-panel--on' : '')} aria-label="动态心率波形">
    <div className="pulse-panel__header">
      <span className="pulse-panel__icon"><HeartPulse size={20} /></span>
      <div className="pulse-panel__heading"><h3>动态心率波形</h3><p>本机 PPG 光学信号 · 实验性估计</p></div>
      <label className="pulse-panel__toggle">
        <input type="checkbox" role="switch" checked={enabled} onChange={event => toggle(event.target.checked)} aria-label="开启本机心率波形" />
        <span className="pulse-panel__switch" aria-hidden="true" />
        <span>{enabled ? '已开启' : '开启波形'}</span>
      </label>
    </div>
    <div className="pulse-panel__body">
      <div className="pulse-panel__chart">
        <div className="pulse-panel__chart-top"><span><Activity size={14} /> 实时光学波形</span><span className={'pulse-panel__status' + (displayBpm !== null ? ' is-ready' : '')}>{status}</span></div>
        <div className="pulse-panel__graph">
          <svg viewBox="0 0 600 84" preserveAspectRatio="none" role="img" aria-label={displayPoints.length ? '实时摄像头光学信号波形' : '等待光学信号的基线'}>
            <line x1="0" y1="42" x2="600" y2="42" className="pulse-panel__baseline" />
            <path d={pulseWaveformPath(displayPoints)} className="pulse-panel__line" />
          </svg>
          {enabled && <span className="pulse-panel__scan" aria-hidden="true" />}
        </div>
      </div>
      <div className="pulse-panel__metric"><span>估计心率</span><strong>{displayBpm ?? '--'}<small> BPM</small></strong><em>{displayBpm === null ? '等待可靠信号' : '仅供个人观察'}</em></div>
    </div>
    <p className="pulse-panel__privacy"><ShieldCheck size={14} /> 开启后仅在本机读取当前摄像头画面；不上传、不保存、不参与招聘评分。估计值并非医疗测量。</p>
  </section>
}
