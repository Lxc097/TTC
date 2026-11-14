import { useCallback, useEffect, useRef, useState } from 'react';

export type DeviceStatus = 'idle' | 'requesting' | 'ready' | 'denied' | 'unavailable' | 'error';
export const CAMERA_DEVICE_KEY = 'interview.cameraDeviceId';
export const MICROPHONE_DEVICE_KEY = 'interview.microphoneDeviceId';

const stopTracks = (stream: MediaStream | null) => stream?.getTracks().forEach((track) => track.stop());

function mediaError(error: unknown, device: 'camera' | 'microphone') {
  const name = error instanceof DOMException ? error.name : '';
  const label = device === 'camera' ? '摄像头' : '麦克风';
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(name)) return {
    status: 'denied' as const, message: label + '权限被拒绝。请在浏览器地址栏的权限设置中允许访问，然后重试。',
  };
  if (['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'].includes(name)) return {
    status: 'unavailable' as const, message: '未找到可用的' + label + '设备。请检查连接；你仍可使用纯文字面试。',
  };
  if (['NotReadableError', 'TrackStartError'].includes(name)) return {
    status: 'error' as const, message: label + '可能正被其他应用占用。请关闭占用设备的程序后重试。',
  };
  return { status: 'error' as const, message: label + '启动失败。请确认设备已连接，并使用 localhost 或 HTTPS 打开页面。' };
}

function savedCameraId() {
  try { return sessionStorage.getItem(CAMERA_DEVICE_KEY) || ''; }
  catch { return ''; }
}

function savedMicrophoneId() {
  try { return sessionStorage.getItem(MICROPHONE_DEVICE_KEY) || ''; }
  catch { return ''; }
}

export function useMediaDevices() {
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [microphoneStream, setMicrophoneStream] = useState<MediaStream | null>(null);
  const [cameraStatus, setCameraStatus] = useState<DeviceStatus>('idle');
  const [microphoneStatus, setMicrophoneStatus] = useState<DeviceStatus>('idle');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [microphoneDevices, setMicrophoneDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState(savedCameraId);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState(savedMicrophoneId);
  const [micLevel, setMicLevel] = useState(0);
  const cameraRef = useRef<MediaStream | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(false);
  const cameraRequestRef = useRef(0);
  const microphoneRequestRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const monitorFrameRef = useRef<number | null>(null);
  const isSupported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

  const selectCamera = useCallback((id: string) => {
    setSelectedCameraId(id);
    try {
      if (id) sessionStorage.setItem(CAMERA_DEVICE_KEY, id);
      else sessionStorage.removeItem(CAMERA_DEVICE_KEY);
    } catch { /* Storage is optional. */ }
  }, []);

  const selectMicrophone = useCallback((id: string) => {
    setSelectedMicrophoneId(id);
    try {
      if (id) sessionStorage.setItem(MICROPHONE_DEVICE_KEY, id);
      else sessionStorage.removeItem(MICROPHONE_DEVICE_KEY);
    } catch { /* Storage is optional. */ }
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (mountedRef.current) setCameraDevices(devices.filter((device) => device.kind === 'videoinput'));
      if (mountedRef.current) setMicrophoneDevices(devices.filter((device) => device.kind === 'audioinput'));
    } catch { /* Device enumeration may be restricted before permission. */ }
  }, []);

  const stopMonitor = useCallback(() => {
    if (monitorFrameRef.current !== null) cancelAnimationFrame(monitorFrameRef.current);
    monitorFrameRef.current = null;
    if (audioContextRef.current) void audioContextRef.current.close().catch(() => undefined);
    audioContextRef.current = null;
    if (mountedRef.current) setMicLevel(0);
  }, []);

  const stopCamera = useCallback(() => {
    cameraRequestRef.current += 1;
    stopTracks(cameraRef.current);
    cameraRef.current = null;
    if (mountedRef.current) {
      setCameraStream(null);
      setCameraStatus('idle');
      setCameraError(null);
    }
  }, []);

  const stopMicrophone = useCallback(() => {
    microphoneRequestRef.current += 1;
    stopMonitor();
    stopTracks(microphoneRef.current);
    microphoneRef.current = null;
    if (mountedRef.current) {
      setMicrophoneStream(null);
      setMicrophoneStatus('idle');
      setMicrophoneError(null);
    }
  }, [stopMonitor]);

  const startCamera = useCallback(async (deviceId?: string): Promise<boolean> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus('unavailable');
      setCameraError('此浏览器无法访问摄像头。请使用支持 MediaDevices 的浏览器，并在 localhost 或 HTTPS 下打开。');
      return false;
    }
    const requestId = ++cameraRequestRef.current;
    setCameraStatus('requesting');
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' },
      });
      if (!mountedRef.current || requestId !== cameraRequestRef.current) {
        stopTracks(stream);
        return false;
      }
      stopTracks(cameraRef.current);
      cameraRef.current = stream;
      setCameraStream(stream);
      setCameraStatus('ready');
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (!mountedRef.current || cameraRef.current !== stream) return;
        cameraRef.current = null;
        setCameraStream(null);
        setCameraStatus('unavailable');
        setCameraError('摄像头连接已中断。请检查设备连接后重新开启。');
        void refreshDevices();
      });
      selectCamera(stream.getVideoTracks()[0]?.getSettings().deviceId || deviceId || '');
      void refreshDevices();
      return true;
    } catch (error) {
      if (!mountedRef.current || requestId !== cameraRequestRef.current) return false;
      const details = mediaError(error, 'camera');
      setCameraStatus(cameraRef.current ? 'ready' : details.status);
      setCameraError(details.message);
      return false;
    }
  }, [refreshDevices, selectCamera]);

  const checkMicrophone = useCallback(async (deviceId?: string): Promise<boolean> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicrophoneStatus('unavailable');
      setMicrophoneError('此浏览器无法访问麦克风。文字输入仍可正常使用。');
      return false;
    }
    const requestId = ++microphoneRequestRef.current;
    setMicrophoneStatus('requesting');
    setMicrophoneError(null);
    try {
      const chosenId = deviceId ?? selectedMicrophoneId;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: chosenId ? { deviceId: { exact: chosenId } } : true, video: false });
      if (!mountedRef.current || requestId !== microphoneRequestRef.current) {
        stopTracks(stream);
        return false;
      }
      stopMonitor();
      stopTracks(microphoneRef.current);
      microphoneRef.current = stream;
      setMicrophoneStream(stream);
      setMicrophoneStatus('ready');
      selectMicrophone(stream.getAudioTracks()[0]?.getSettings().deviceId || chosenId || '');
      void refreshDevices();
      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (!mountedRef.current || microphoneRef.current !== stream) return;
        stopMonitor();
        microphoneRef.current = null;
        setMicrophoneStream(null);
        setMicrophoneStatus('unavailable');
        setMicrophoneError('麦克风连接已中断。请检查设备连接后重新检测。');
      });
      try {
        const context = new AudioContext();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        audioContextRef.current = context;
        const samples = new Uint8Array(analyser.frequencyBinCount);
        let lastUpdate = 0;
        const sample = (time: number) => {
          if (!mountedRef.current || microphoneRef.current !== stream) return;
          if (time - lastUpdate > 90) {
            analyser.getByteTimeDomainData(samples);
            const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
            setMicLevel(Math.min(100, Math.round(rms * 450)));
            lastUpdate = time;
          }
          monitorFrameRef.current = requestAnimationFrame(sample);
        };
        monitorFrameRef.current = requestAnimationFrame(sample);
      } catch { /* A live track still confirms microphone permission. */ }
      return true;
    } catch (error) {
      if (!mountedRef.current || requestId !== microphoneRequestRef.current) return false;
      const details = mediaError(error, 'microphone');
      setMicrophoneStatus(microphoneRef.current ? 'ready' : details.status);
      setMicrophoneError(details.message);
      return false;
    }
  }, [refreshDevices, selectMicrophone, selectedMicrophoneId, stopMonitor]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => {
      mountedRef.current = false;
      cameraRequestRef.current += 1;
      microphoneRequestRef.current += 1;
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
      stopTracks(cameraRef.current);
      stopTracks(microphoneRef.current);
      cameraRef.current = null;
      microphoneRef.current = null;
      stopMonitor();
    };
  }, [refreshDevices, stopMonitor]);

  return {
    isSupported, cameraStream, microphoneStream, cameraStatus, microphoneStatus,
    cameraError, microphoneError, cameraDevices, microphoneDevices, selectedCameraId, selectedMicrophoneId, selectCamera, selectMicrophone,
    micLevel, refreshDevices, startCamera, stopCamera, checkMicrophone, stopMicrophone,
  };
}
