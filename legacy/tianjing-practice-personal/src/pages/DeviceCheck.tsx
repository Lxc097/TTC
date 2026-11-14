import { useState } from 'react';
import { ArrowLeft, ArrowRight, Camera, CameraOff, Info, LoaderCircle, Mic, MicOff, RefreshCw, ShieldCheck } from 'lucide-react';
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
  onContinue: (result: DeviceCheckResult) => void;
  onBack: () => void;
}

const statusText: Record<DeviceStatus, string> = {
  idle: '尚未检测', requesting: '正在请求权限', ready: '已连接',
  denied: '权限被拒绝', unavailable: '未发现设备', error: '连接异常',
};

export function DeviceCheck({ mode = 'mock', onContinue, onBack }: DeviceCheckProps) {
  const camera = useCameraManager();
  const devices = useMediaDevices();
  const [consent, setConsent] = useState<boolean | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [textOnly, setTextOnly] = useState(false);
  const [typingOnly, setTypingOnly] = useState(false);
  const cameraEnabled = camera.status === 'ready' && Boolean(camera.stream);
  const microphoneEnabled = devices.microphoneStatus === 'ready' && Boolean(devices.microphoneStream);
  const blocker = !textOnly && !cameraEnabled
    ? '请先开启摄像头；不使用设备时，请明确选择纯文字面试。'
    : !textOnly && !typingOnly && !microphoneEnabled
      ? '请先检测麦克风，或选择仅打字作答。'
      : consent === null ? '请选择是否同意画面分析。'
        : !confirmed ? '请确认设备状态后继续。' : '';

  function chooseTextOnly(enabled: boolean) {
    setTextOnly(enabled);
    if (enabled) {
      camera.stop();
      devices.stopMicrophone();
      setTypingOnly(true);
      setConsent(false);
    }
  }

  function chooseTypingOnly(enabled: boolean) {
    setTypingOnly(enabled);
    if (enabled) devices.stopMicrophone();
  }

  function continueInterview() {
    if (blocker) return;
    onContinue({
      cameraEnabled: !textOnly && cameraEnabled,
      microphoneEnabled: !textOnly && !typingOnly && microphoneEnabled,
      consent: !textOnly && consent === true,
      cameraDeviceId: textOnly ? '' : camera.selectedDeviceId,
    });
  }

  return (
    <main className="device-page">
      <div className="device-page__top">
        <button type="button" className="device-back" onClick={onBack}><ArrowLeft size={17} /> 返回</button>
        <span className="device-page__step">设备检测 <span>／</span> {mode === 'room' ? '加入房间' : '模拟面试'}</span>
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
              <button type="button" className="device-button device-button--primary" disabled={camera.status === 'requesting'} onClick={() => { setTextOnly(false); void camera.start(camera.selectedDeviceId || undefined); }}>
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
            <div className="device-mic-actions">
              {microphoneEnabled ? <button type="button" className="device-button device-button--secondary" onClick={devices.stopMicrophone}><MicOff size={17} /> 关闭麦克风</button> : <button type="button" className="device-button device-button--secondary" disabled={devices.microphoneStatus === 'requesting'} onClick={() => { setTextOnly(false); setTypingOnly(false); void devices.checkMicrophone(); }}>{devices.microphoneStatus === 'requesting' ? <LoaderCircle size={17} className="device-spin" /> : <Mic size={17} />} 检测麦克风</button>}
            </div>
            <label className="device-select-label" htmlFor="microphone-device">使用的麦克风</label>
            <select id="microphone-device" className="device-select" value={devices.microphoneDevices.some(item => item.deviceId === devices.selectedMicrophoneId) ? devices.selectedMicrophoneId : ''} onChange={event => {
              const id = event.target.value;
              if (microphoneEnabled) { setTypingOnly(false); void devices.checkMicrophone(id); }
              else devices.selectMicrophone(id);
            }}>
              <option value="">系统默认麦克风</option>
              {devices.microphoneDevices.filter(item => item.deviceId).map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || '麦克风 ' + (index + 1)}</option>)}
            </select>
            <label className="device-mic-text-choice"><input type="checkbox" checked={typingOnly} onChange={event => chooseTypingOnly(event.target.checked)} /> 不用麦克风，仅打字作答</label>
            {devices.microphoneError && <p className="device-alert" role="alert">{devices.microphoneError}</p>}
            <p className="device-helper">若输入电平不动，请检查所选设备及系统权限。面试中也可打字作答。</p>
          </section>

          <section className="device-card device-card--consent">
            <div className="device-card__title"><span className="device-icon"><ShieldCheck size={19} /></span><div><h2>画面分析授权</h2><p>请明确选择是否授权后续图像分析</p></div></div>
            <p className="device-consent-copy">同意后，若 FacePhys 服务已配置，面试将按约 30 秒片段上传摄像头画面用于分析；每场最多 5 段。未配置或失败时会明确提示，不会将演示数据标为真实结果。不同意不影响面试。</p>
            <div className="device-consent-options" role="radiogroup" aria-label="是否同意画面分析">
              <label className={consent === true ? 'is-selected' : ''}><input type="radio" name="analysis-consent" checked={consent === true} disabled={textOnly} onChange={() => setConsent(true)} /> 同意并默认使用 FacePhys</label>
              <label className={consent === false ? 'is-selected' : ''}><input type="radio" name="analysis-consent" checked={consent === false} onChange={() => setConsent(false)} /> 暂不同意，仅参加面试</label>
            </div>
            <label className={'device-text-choice' + (textOnly ? ' is-selected' : '')}>
              <input type="checkbox" checked={textOnly} onChange={event => chooseTextOnly(event.target.checked)} />
              <span><strong>使用纯文字面试</strong><small>无需摄像头与麦克风，不会发送任何画面。</small></span>
            </label>
            <div className="device-card__continue">
              <label className="device-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> 我已确认设备状态，准备继续</label>
              <p className="device-continue-note"><Info size={14} /> {mode === 'room' ? '等候室不会建立真实音视频连接。' : textOnly ? '本次将以纯文字方式进行。' : '进入面试时复用当前摄像头；离开时自动释放。'}</p>
              {blocker && <p className="device-blocker" role="status">{blocker}</p>}
              <button type="button" className="device-button device-button--primary device-button--continue" disabled={Boolean(blocker)} onClick={continueInterview}>{mode === 'room' ? '前往等候室' : '开始面试'} <ArrowRight size={18} /></button>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

export default DeviceCheck;
