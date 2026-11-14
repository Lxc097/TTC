import { useEffect, useRef } from 'react'
import './AudioWaveform.css'

export interface AudioWaveformProps {
  analyser: AnalyserNode | null
  kind: 'ai' | 'user' | 'thinking'
  active: boolean
  className?: string
  onLevel?: (level: number) => void
  onAmplitude?: (rms: number) => void
}

/** Canvas samples only the supplied live AnalyserNode; no generated waveform. */
export function AudioWaveform({ analyser, kind, active, className = '', onLevel, onAmplitude }: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const callbacksRef = useRef({ onLevel, onAmplitude })
  callbacksRef.current = { onLevel, onAmplitude }

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    let frame: number | null = null
    let lastLevelUpdate = 0
    const sampleData = analyser ? new Uint8Array(analyser.fftSize) : null

    const paint = (now: number) => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      context.clearRect(0, 0, width, height)
      context.lineWidth = kind === 'user' ? 2.3 : 2.6
      context.strokeStyle = kind === 'user' ? '#16803a' : '#5b7fff'
      context.lineJoin = 'round'
      context.lineCap = 'round'
      context.beginPath()

      if (active && analyser && sampleData) {
        analyser.getByteTimeDomainData(sampleData)
        let squared = 0
        const stride = Math.max(1, Math.floor(sampleData.length / Math.max(1, width)))
        let x = 0
        for (let i = 0; i < sampleData.length; i += stride) {
          const value = (sampleData[i] - 128) / 128
          squared += value * value
          const y = height / 2 + value * height * 0.43
          if (x === 0) context.moveTo(x, y)
          else context.lineTo(x, y)
          x += width / Math.ceil(sampleData.length / stride)
        }
        const sampleCount = Math.ceil(sampleData.length / stride)
        const rms = Math.min(1, Math.sqrt(squared / sampleCount))
        const level = Math.min(1, rms * 5)
        if (now - lastLevelUpdate >= 90) {
          callbacksRef.current.onLevel?.(level)
          callbacksRef.current.onAmplitude?.(rms)
          lastLevelUpdate = now
        }
        context.stroke()
        frame = requestAnimationFrame(paint)
      } else {
        context.moveTo(0, height / 2)
        context.lineTo(width, height / 2)
        context.stroke()
        callbacksRef.current.onLevel?.(0)
        callbacksRef.current.onAmplitude?.(0)
      }
    }

    const resize = () => {
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      const width = Math.max(1, canvas.clientWidth)
      const height = Math.max(1, canvas.clientHeight)
      canvas.width = Math.round(width * pixelRatio)
      canvas.height = Math.round(height * pixelRatio)
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      if (!active || !analyser) paint(performance.now())
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()
    if (active && analyser) frame = requestAnimationFrame(paint)
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      callbacksRef.current.onLevel?.(0)
      callbacksRef.current.onAmplitude?.(0)
    }
  }, [active, analyser, kind])

  const fallback = kind === 'thinking'
    ? '正在组织下一道问题'
    : !active
      ? '等待音频'
      : kind === 'ai'
        ? '浏览器朗读音量不可读取'
        : '麦克风未提供可分析音频'
  const label = active && analyser
    ? kind === 'user' ? '真实麦克风音频波形' : '真实面试官音频波形'
    : fallback

  return <div className={'audio-waveform audio-waveform--' + kind + ' ' + className}>
    <canvas ref={canvasRef} role="img" aria-label={label} />
    {(!active || !analyser) && <span className="audio-waveform__fallback">
      {kind === 'thinking' && <span className="audio-waveform__thinking-dot" aria-hidden="true" />}
      {fallback}
    </span>}
  </div>
}
