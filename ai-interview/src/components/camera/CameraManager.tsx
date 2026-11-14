import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type { DeviceStatus } from '../../hooks/useMediaDevices'

export const CAMERA_DEVICE_KEY = 'interview.cameraDeviceId'

interface CameraManagerValue {
  stream: MediaStream | null
  status: DeviceStatus
  error: string | null
  devices: MediaDeviceInfo[]
  selectedDeviceId: string
  isSupported: boolean
  start: (deviceId?: string) => Promise<boolean>
  stop: () => void
  selectDevice: (deviceId: string) => void
  refreshDevices: () => Promise<void>
}

const CameraContext = createContext<CameraManagerValue | null>(null)

function initialDeviceId() {
  try { return sessionStorage.getItem(CAMERA_DEVICE_KEY) || '' } catch { return '' }
}

function cameraFailure(error: unknown): { status: DeviceStatus; message: string } {
  const name = error instanceof DOMException ? error.name : ''
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(name))
    return { status: 'denied', message: '摄像头权限被拒绝。请在浏览器地址栏允许访问后重试。' }
  if (['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'].includes(name))
    return { status: 'unavailable', message: '未找到所选摄像头。请检查连接、刷新设备列表，或使用纯文字面试。' }
  if (['NotReadableError', 'TrackStartError'].includes(name))
    return { status: 'error', message: '摄像头可能正被其他应用占用。请关闭占用设备的程序后重试。' }
  return { status: 'error', message: '摄像头启动失败。请在 localhost 或 HTTPS 页面中重试。' }
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach(track => track.stop())
}

/** Owns one original-resolution capture stream across device check and interview. */
export function CameraManagerProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [status, setStatus] = useState<DeviceStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState(initialDeviceId)
  const streamRef = useRef<MediaStream | null>(null)
  const endedListenerRef = useRef<(() => void) | null>(null)
  const mountedRef = useRef(false)
  const requestRef = useRef(0)
  const isSupported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)

  const selectDevice = useCallback((deviceId: string) => {
    setSelectedDeviceId(deviceId)
    try {
      if (deviceId) sessionStorage.setItem(CAMERA_DEVICE_KEY, deviceId)
      else sessionStorage.removeItem(CAMERA_DEVICE_KEY)
    } catch { /* Camera selection still works without storage. */ }
  }, [])

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      if (mountedRef.current) setDevices(all.filter(device => device.kind === 'videoinput'))
    } catch { /* Before permission, enumeration may be restricted. */ }
  }, [])

  const releaseCurrent = useCallback(() => {
    const current = streamRef.current
    const track = current?.getVideoTracks()[0]
    if (track && endedListenerRef.current) track.removeEventListener('ended', endedListenerRef.current)
    endedListenerRef.current = null
    streamRef.current = null
    stopTracks(current)
  }, [])

  const stop = useCallback(() => {
    requestRef.current += 1
    releaseCurrent()
    if (mountedRef.current) {
      setStream(null)
      setStatus('idle')
      setError(null)
    }
  }, [releaseCurrent])

  const start = useCallback(async (deviceId?: string): Promise<boolean> => {
    const chosen = deviceId === undefined ? selectedDeviceId : deviceId
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unavailable')
      setError('浏览器无法访问摄像头。请使用 localhost 或 HTTPS 打开页面。')
      return false
    }
    const active = streamRef.current?.getVideoTracks()[0]
    if (active?.readyState === 'live' && deviceId === undefined) return true
    if (active?.readyState === 'live' && chosen && active.getSettings().deviceId === chosen) return true
    const request = ++requestRef.current
    selectDevice(chosen)
    // Release a different device before opening the new one to avoid camera lock conflicts.
    releaseCurrent()
    setStream(null)
    setStatus('requesting')
    setError(null)
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: chosen ? { deviceId: { exact: chosen }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      if (!mountedRef.current || request !== requestRef.current) {
        stopTracks(next)
        return false
      }
      const track = next.getVideoTracks()[0]
      if (!track) {
        stopTracks(next)
        setStatus('unavailable')
        setError('浏览器没有返回可用的视频轨道。')
        return false
      }
      const onEnded = () => {
        if (!mountedRef.current || streamRef.current !== next) return
        endedListenerRef.current = null
        streamRef.current = null
        setStream(null)
        setStatus('unavailable')
        setError('摄像头连接已中断。请检查设备后重新开启。')
        void refreshDevices()
      }
      endedListenerRef.current = onEnded
      track.addEventListener('ended', onEnded)
      streamRef.current = next
      setStream(next)
      setStatus('ready')
      selectDevice(track.getSettings().deviceId || chosen)
      void refreshDevices()
      return true
    } catch (cause) {
      if (!mountedRef.current || request !== requestRef.current) return false
      const failure = cameraFailure(cause)
      setStatus(failure.status)
      setError(failure.message)
      return false
    }
  }, [refreshDevices, releaseCurrent, selectDevice, selectedDeviceId])

  useEffect(() => {
    mountedRef.current = true
    void refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices)
    return () => {
      mountedRef.current = false
      requestRef.current += 1
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices)
      releaseCurrent()
    }
  }, [refreshDevices, releaseCurrent])

  useEffect(() => {
    if (pathname !== '/device-check' && pathname !== '/interview') stop()
  }, [pathname, stop])

  const value = useMemo<CameraManagerValue>(() => ({
    stream, status, error, devices, selectedDeviceId, isSupported,
    start, stop, selectDevice, refreshDevices,
  }), [stream, status, error, devices, selectedDeviceId, isSupported, start, stop, selectDevice, refreshDevices])
  return <CameraContext.Provider value={value}>{children}</CameraContext.Provider>
}

export function useCameraManager(): CameraManagerValue {
  const manager = useContext(CameraContext)
  if (!manager) throw new Error('CameraManagerProvider 尚未安装。')
  return manager
}
