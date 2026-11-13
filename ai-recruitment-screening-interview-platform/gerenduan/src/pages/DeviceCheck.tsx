import { useState } from 'react';
import { ArrowLeft, ArrowRight, Camera, CameraOff, Check, Info, LoaderCircle, Mic, MicOff, RefreshCw, ShieldCheck } from 'lucide-react';
import { CameraPreview } from '../components/camera/CameraPreview';
import { useCameraManager } from '../components/camera/CameraManager';
import { useMediaDevices, type DeviceStatus } from '../hooks/useMediaDevices';
import './DeviceCheck.css';

export interface DeviceCheckResult {
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
  consent: boolean;
  cameraDeviceId: string;
}

interface DeviceCheckProps {
  mode?: 'mock' | 'room';
  formal?: boolean;
  onContinue: (result: DeviceCheckResult) => void;
  onBack: () => void;
}

const statusText: Record<DeviceStatus, string> = {
  idle: '尚未检测', requesting: '正在请求权限', ready: '已连接',
  denied: '权限被拒绝', unavailable: '未发现设备', error: '连接异常',
};

export function DeviceCheck({ mode = 'mock', formal = false, onContinue, onBack }: DeviceCheckProps) {
  const camera = useCameraManager();
  const devices = useMediaDevices();
  const [consent, setConsent] = useState<boolean | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const cameraEnabled = camera.status === 'ready' && Boolean(camera.stream);
  const microphoneEnabled = devices.microphoneStatus === 'ready' && Boolean(devices.microphoneStream);
  const canContinue = confirmed && (formal || consent !== null);

  return (
    <main className="device-page">
      <div className="device-page__top">
        <button type="button" className="device-back" onClick={onBack}><ArrowLeft size={17} /> 返回</button>
        <span className="device-page__step">设备检测 <span>／</span> {formal ? '岗位 AI 初面' : mode === 'room' ? '加入房间' : '模拟面试'}</span>
      </div>
      <header className="device-page__heading">
        <div>
          <span className="device-eyebrow">正式开始前</span>
          <h1>检查你的设备</h1>
          <p>接入摄像头与麦克风，确认画面和声音正常。也可以直接使用纯文字方式参加。</p>
        </div>
        <span className="device-page__privacy"><ShieldCheck size={17} /> 设备检测画面仅在本机预览</span>
      </header>

      <div className="device-grid">
        <section className="device-card device-card--preview" aria-label="摄像头检测">
          <div className="device-card__title"><span className="device-icon"><Camera size={19} /></span><div><h2>摄像头</h2><p>检查实时画面并选择使用的设备</p></div><span className={'device-status device-status--' + camera.status}>{statusText[camera.status]}</span></div>
          <CameraPreview stream={camera.stream} emptyLabel={camera.status === 'requesting' ? '正在连接摄像头…' : '开启摄像头后，实时画面将在这里显示'} />
          <div className="device-camera-actions">
            {cameraEnabled ? (
              <button type="button" className="device-button device-button--secondary" onClick={camera.stop}><CameraOff size={17} /> 关闭摄像头</button>
            ) : (
              <button type="button" className="device-button device-button--primary" disabled={camera.status === 'requesting'} onClick={() => void camera.start(camera.selectedDeviceId || undefined)}>
                {camera.status === 'requesting' ? <LoaderCircle size={17} className="device-spin" /> : <Camera size={17} />} 开启摄像头
              </button>
            )}
            <button type="button" className="device-icon-button" onClick={() => void camera.refreshDevices()} aria-label="刷新设备列表" title="刷新设备列表"><RefreshCw size={17} /></button>
          </div>
          <label className="device-select-label" htmlFor="camera-device">使用的摄像头</label>
          <select id="camera-device" className="device-select" value={camera.devices.some((item) => item.deviceId === camera.selectedDeviceId) ? camera.selectedDeviceId : ''} onChange={(event) => {
            const id = event.target.value;
            if (cameraEnabled) void camera.start(id);
            else camera.selectDevice(id);
          }}>
            <option value="">系统默认摄像头</option>
            {camera.devices.filter((item) => item.deviceId).map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || '摄像头 ' + (index + 1)}</option>)}
          </select>
          {camera.devices.length === 0 && <p className="device-helper">设备名称通常会在授权后显示。如设备未出现，请先检查系统连接。</p>}
          {camera.error && <p className="device-alert" role="alert">{camera.error}</p>}
        </section>

        <div className="device-side">
          <section className="device-card" aria-label="麦克风检测">
            <div className="device-card__title"><span className="device-icon"><Mic size={19} /></span><div><h2>麦克风</h2><p>检查权限与输入电平</p></div><span className={'device-status device-status--' + devices.microphoneStatus}>{statusText[devices.microphoneStatus]}</span></div>
            <div className="device-mic-meter"><div className="device-mic-meter__top"><span>{microphoneEnabled ? (devices.micLevel > 5 ? '检测到声音输入' : '已连接，请说几句话') : '尚未开始检测'}</span><span>{microphoneEnabled ? devices.micLevel + '%' : '—'}</span></div><div className="device-mic-meter__track"><span style={{ width: microphoneEnabled ? Math.max(devices.micLevel, 2) + '%' : '0%' }} /></div></div>
            {microphoneEnabled ? <button type="button" className="device-button device-button--secondary" onClick={devices.stopMicrophone}><MicOff size={17} /> 关闭麦克风</button> : <button type="button" className="device-button device-button--secondary" disabled={devices.microphoneStatus === 'requesting'} onClick={() => void devices.checkMicrophone()}>{devices.microphoneStatus === 'requesting' ? <LoaderCircle size={17} className="device-spin" /> : <Mic size={17} />} 检测麦克风</button>}
            {devices.microphoneError && <p className="device-alert" role="alert">{devices.microphoneError}</p>}
            <p className="device-helper">语音转写由浏览器调用系统默认麦克风；若电平不动或没有识别文字，请检查系统输入设备。听不到题目时也可阅读文字并直接打字作答。</p>
          </section>

          {formal ? <section className="device-card device-card--consent"><div className="device-card__title"><span className="device-icon"><ShieldCheck size={19} /></span><div><h2>画面隐私</h2><p>本次招聘初面只根据岗位问题与回答进行对话</p></div></div><p className="device-consent-copy">摄像头仅用于本机预览，不发送画面进行生理分析。麦克风由浏览器转写；也可以全程使用文字回答。</p></section> : <section className="device-card device-card--consent">
            <div className="device-card__title"><span className="device-icon"><ShieldCheck size={19} /></span><div><h2>画面分析授权</h2><p>请明确选择是否授权后续图像分析</p></div></div>
            <p className="device-consent-copy">{formal ? '画面分析是可选项。只有你主动选择 FacePhys 真实分析且已授权时，才会录制约 30 秒视频片段并上传第三方处理；不同意不影响初面。' : '演示模式不会分析摄像头画面。只有你在面试中主动选择 FacePhys 真实分析且已授权时，才会录制约 30 秒视频片段并上传第三方处理；选择不同意不影响面试。'}</p>
            <div className="device-consent-options" role="radiogroup" aria-label="是否同意画面分析">
              <label className={consent === true ? 'is-selected' : ''}><input type="radio" name="analysis-consent" checked={consent === true} onChange={() => setConsent(true)} /> 同意后续画面分析</label>
              <label className={consent === false ? 'is-selected' : ''}><input type="radio" name="analysis-consent" checked={consent === false} onChange={() => setConsent(false)} /> 暂不同意，仅参加面试</label>
            </div>
          </section>}
        </div>
      </div>

      <footer className="device-page__footer">
        <div className="device-page__footer-copy"><label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> <span>我已确认设备状态，准备继续</span></label><small><Info size={14} /> {mode === 'room' ? '进入等候室后会释放摄像头与麦克风。' : '进入面试时复用当前摄像头；离开面试后自动释放媒体轨道。'}</small></div>
        <button type="button" className="device-button device-button--primary device-button--continue" disabled={!canContinue} onClick={() => onContinue({ cameraEnabled, microphoneEnabled, consent: !formal && consent === true, cameraDeviceId: camera.selectedDeviceId })}>{mode === 'room' ? '前往等候室' : '开始面试'} <ArrowRight size={18} /></button>
      </footer>
      {!cameraEnabled && <p className="device-text-mode"><Check size={15} /> {mode === 'room' ? '仍可进入演示等候室；当前不会建立真实音视频连接。' : '当前可使用纯文字面试；摄像头不是继续的必要条件。'}</p>}
    </main>
  );
}

export default DeviceCheck;
