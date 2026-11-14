import { useEffect, useRef } from 'react';
import { CameraOff } from 'lucide-react';
import './CameraPreview.css';

interface CameraPreviewProps {
  stream: MediaStream | null;
  emptyLabel?: string;
  mirrored?: boolean;
  className?: string;
  onVideoElement?: (element: HTMLVideoElement | null) => void;
}

export function CameraPreview({ stream, emptyLabel = '摄像头未开启', mirrored = false, className = '', onVideoElement }: CameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    onVideoElement?.(stream ? video : null);
    if (stream) void video.play().catch(() => undefined);
    return () => { video.srcObject = null; onVideoElement?.(null); };
  }, [stream, onVideoElement]);

  return (
    <div className={'camera-preview ' + className}>
      {stream ? (
        <video ref={videoRef} autoPlay playsInline muted aria-label="实时摄像头画面" style={{ transform: mirrored ? 'scaleX(-1)' : undefined }} />
      ) : (
        <div className="camera-preview__empty" role="status">
          <span className="camera-preview__empty-icon"><CameraOff size={27} strokeWidth={1.7} /></span>
          <span>{emptyLabel}</span>
          <small>这里仅显示当前设备的实时画面</small>
        </div>
      )}
      {stream && <span className="camera-preview__live"><span />实时预览</span>}
    </div>
  );
}
