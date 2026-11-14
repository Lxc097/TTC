import { Camera, Mic } from 'lucide-react'

interface DeviceStatusProps {
  cameraStatus: string
  micStatus: string
  micLevel: number
  notice?: string
}

export function DeviceStatus({ cameraStatus, micStatus, micLevel, notice }: DeviceStatusProps) {
  const cameraReady = cameraStatus === 'ready'
  const micReady = micStatus === 'ready'
  const percent = micReady ? Math.max(0, Math.min(100, Math.round(micLevel * 100))) : 0

  return <div className="room-device">
    <div className="room-device__items" aria-label="设备连接">
      <span className={cameraReady ? 'is-ready' : ''}><Camera size={15} />摄像头{cameraReady ? '已连接' : '未连接'}</span>
      <span className={micReady ? 'is-ready' : ''}><Mic size={15} />麦克风{micReady ? '已连接' : '未连接'}</span>
      {micReady && <span className="room-device__level" title="真实麦克风输入电平">输入 {percent}%</span>}
    </div>
    {notice && <p role="alert">{notice}</p>}
  </div>
}
