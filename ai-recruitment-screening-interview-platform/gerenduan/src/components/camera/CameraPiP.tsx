import { useState } from 'react'
import { Camera, CameraOff, Maximize2, Minimize2, ScanFace } from 'lucide-react'
import { CameraPreview } from './CameraPreview'
import { useCameraManager } from './CameraManager'
import './CameraPiP.css'

export interface CameraPiPProps {
  onVideoElement?: (element: HTMLVideoElement | null) => void
}

/** Display-only resizing never changes the original MediaStream constraints. */
export function CameraPiP({ onVideoElement }: CameraPiPProps) {
  const camera = useCameraManager()
  const [expanded, setExpanded] = useState(false)
  const [mirrored, setMirrored] = useState(true)
  const live = camera.status === 'ready' && Boolean(camera.stream)

  return <div className={'camera-pip' + (expanded ? ' camera-pip--expanded' : '')} aria-label="我的摄像头画中画">
    <CameraPreview stream={camera.stream} mirrored={mirrored} onVideoElement={onVideoElement}
      emptyLabel={camera.status === 'requesting' ? '正在连接…' : '文字面试可用'} />
    <div className="camera-pip__top">
      <span className={live ? 'camera-pip__state is-live' : 'camera-pip__state'}>{live ? '实时画面' : '未连接'}</span>
      <div className="camera-pip__controls">
        <button type="button" onClick={() => setMirrored(value => !value)} title={mirrored ? '关闭镜像' : '开启镜像'} aria-label={mirrored ? '关闭镜像' : '开启镜像'}><ScanFace size={14} /></button>
        <button type="button" onClick={() => setExpanded(value => !value)} title={expanded ? '恢复小窗' : '放大画面'} aria-label={expanded ? '恢复小窗' : '放大画面'}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
        <button type="button" disabled={camera.status === 'requesting'} onClick={() => live ? camera.stop() : void camera.start()}
          title={live ? '关闭摄像头' : '开启摄像头'} aria-label={live ? '关闭摄像头' : '开启摄像头'}>{live ? <CameraOff size={14} /> : <Camera size={14} />}</button>
      </div>
    </div>
    {camera.error && <div className="camera-pip__error" role="alert">{camera.error}</div>}
  </div>
}
