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

  return <section className="room-device">
    <div className="room-section-title"><h3>设备连接</h3><span>本机状态</span></div>
    <div className="room-device__items">
      <span><Camera size={15}/><i className={cameraReady ? 'is-ready' : ''}/>{cameraReady ? '摄像头已连接' : '摄像头未连接'}</span>
      <span><Mic size={15}/><i className={micReady ? 'is-ready' : ''}/>{micReady ? '麦克风已连接' : '麦克风未连接'}</span>
    </div>
    {micReady && <div className="room-device__monitor">
      <div><span>真实麦克风输入</span><strong>{percent}%</strong></div>
      <div className="room-device__meter" role="meter" aria-label="麦克风输入电平" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: percent + '%' }}/></div>
      <small>电平有变化但没有文字？浏览器转写服务可能不可用，可直接打字回答。</small>
    </div>}
    {notice && <p role="alert">{notice}</p>}
  </section>
}
