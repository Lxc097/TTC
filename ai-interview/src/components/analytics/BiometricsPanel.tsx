import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, HeartPulse, Info, Radio, ShieldCheck } from 'lucide-react';
import {
  createBiometricsProvider,
  type BiometricReading,
  type BiometricsMode,
} from '../../services/biometrics';
import { describeQuestionReaction } from '../../utils/answerInsight';
import './biometrics.css';

interface BiometricsPanelProps {
  /** Initial mode; an optional onModeChange can mirror the user's selection upward. */
  mode?: BiometricsMode;
  consent: boolean;
  videoElement?: HTMLVideoElement | null;
  onModeChange?: (mode: BiometricsMode) => void;
  onReading?: (reading: BiometricReading) => void;
}

const qualityLabel = {
  good: '良好',
  fair: '一般',
  poor: '较低',
  unavailable: '不可用',
};

function HeartRateTrend({ readings, isMock }: { readings: BiometricReading[]; isMock: boolean }) {
  const points = readings
    .filter((reading) => reading.heartRateBpm !== null)
    .slice(-16);
  const coords = points.map((reading, index) => {
    const x = points.length === 1 ? 150 : 12 + (index * 276) / (points.length - 1);
    const y = 86 - ((Number(reading.heartRateBpm) - 60) / 40) * 67;
    return { x, y: Math.max(12, Math.min(86, y)) };
  });
  const path = coords.map((point) => point.x + ',' + point.y).join(' ');
  const last = coords.at(-1);

  return (
    <div className="bio-trend">
      <div className="bio-trend-heading">
        <span>心率变化趋势</span>
        <span className="bio-trend-legend">{isMock ? '演示数据' : '分段分析数据'}</span>
      </div>
      <div className="bio-chart-wrap">
        <span className="bio-chart-max">100</span>
        <svg viewBox="0 0 300 100" preserveAspectRatio="none" role="img" aria-label={isMock ? '演示心率变化趋势' : '心率变化趋势'}>
          <line x1="10" y1="18" x2="290" y2="18" className="bio-chart-grid" />
          <line x1="10" y1="52" x2="290" y2="52" className="bio-chart-grid" />
          <line x1="10" y1="86" x2="290" y2="86" className="bio-chart-grid" />
          {coords.length > 1 && <polyline points={path} className="bio-chart-line" />}
          {last && <circle cx={last.x} cy={last.y} r="4" className="bio-chart-dot" />}
        </svg>
        <span className="bio-chart-min">60</span>
      </div>
      <div className="bio-trend-foot"><span>最近记录</span><span>{points.length} 个采样点</span></div>
    </div>
  );
}

export default function BiometricsPanel({
  mode = 'mock',
  consent,
  videoElement,
  onModeChange,
  onReading,
}: BiometricsPanelProps) {
  const [activeMode, setActiveMode] = useState<BiometricsMode>(mode);
  const [readings, setReadings] = useState<BiometricReading[]>([]);
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);
  const onReadingRef = useRef(onReading);
  onReadingRef.current = onReading;

  useEffect(() => setActiveMode(mode), [mode]);

  const provider = useMemo(() => createBiometricsProvider(activeMode), [activeMode]);

  useEffect(() => {
    setReadings([]);
    setRunning(false);
    setMessage('');
    if (!consent) return;

    let active = true;
    const listener = (reading: BiometricReading) => {
      if (!active) return;
      setReadings((current) => [...current.slice(-29), reading]);
      onReadingRef.current?.(reading);
    };
    provider.subscribe(listener);
    void provider.start({ consent, videoElement }).then(() => {
      if (active) setRunning(true);
    }).catch((error: unknown) => {
      if (active) setMessage(error instanceof Error ? error.message : '分析服务暂时不可用。');
    });
    return () => {
      active = false;
      provider.unsubscribe(listener);
      provider.stop();
    };
  }, [consent, provider, videoElement]);

  const latest = readings.at(-1);
  const isMock = activeMode === 'mock';
  const reaction = describeQuestionReaction(latest ?? null);

  const changeMode = (nextMode: BiometricsMode) => {
    setActiveMode(nextMode);
    onModeChange?.(nextMode);
  };

  return (
    <section className="bio-panel" aria-label="生理信号分析">
      <div className="bio-header">
        <div className="bio-title-block">
          <span className="bio-title-icon"><Activity size={18} strokeWidth={2} /></span>
          <div><h3>生理信号观察</h3><p>单独展示，不参与回答评分</p></div>
        </div>
        <span className={isMock ? 'bio-source bio-source-mock' : 'bio-source bio-source-api'}>
          {isMock ? '演示数据' : 'FacePhys · 分段分析'}
        </span>
      </div>

      <div className="bio-mode" role="group" aria-label="生理数据来源">
        <button type="button" className={isMock ? 'is-active' : ''} onClick={() => changeMode('mock')}>演示模式</button>
        <button type="button" className={!isMock ? 'is-active' : ''} onClick={() => changeMode('api')}>FacePhys 真实分析</button>
      </div>

      {!consent ? (
        <div className="bio-empty">
          <ShieldCheck size={24} />
          <strong>等待图像分析授权</strong>
          <span>当前不会读取或发送摄像头画面。可继续完成不含生理分析的面试。</span>
        </div>
      ) : message ? (
        <div className="bio-empty bio-unavailable">
          <Radio size={24} />
          <strong>分析服务未启动</strong>
          <span>{message}</span>
        </div>
      ) : (
        <>
          <div className="bio-live-line"><span className={running ? 'bio-pulse' : 'bio-pulse is-idle'} />{isMock ? (running ? '演示数据更新中' : '正在准备演示数据') : (running ? '本次分段分析已完成' : '正在录制约 30 秒片段并提交分析…')}</div>
          <div className="bio-metrics">
            <div className="bio-metric">
              <div className="bio-metric-label"><HeartPulse size={16} />估计心率</div>
              <strong>{latest?.heartRateBpm ?? '--'} <small>BPM</small></strong>
            </div>
            <div className="bio-metric">
              <div className="bio-metric-label"><Activity size={16} />状态提示</div>
              <strong className="bio-emotion">{reaction.label}</strong>
              <span>{reaction.heartRateBpm ? reaction.heartRateBpm + ' BPM · 仅供过程复盘' : '等待可用信号'}</span>
            </div>
          </div>
          <HeartRateTrend readings={readings} isMock={isMock} />
          <div className="bio-quality"><span><span className="bio-quality-dot" />信号质量</span><strong>{latest ? qualityLabel[latest.signalQuality] : '待采样'}</strong></div>
          {latest?.extraMetrics?.respirationRate != null && (
            <div className="bio-extra"><span>扩展指标 · 呼吸频率</span><strong>{String(latest.extraMetrics.respirationRate)} 次/分</strong></div>
          )}
        </>
      )}

      <p className="bio-disclaimer"><Info size={14} />{isMock ? '以上均为模拟生成的演示数据，与摄像头画面无关。' : '主动选择后会上传一段摄像头视频给 FacePhys；结果是分段分析，仅供过程观察，不作健康、人格或诚信判断。'}</p>
    </section>
  );
}
