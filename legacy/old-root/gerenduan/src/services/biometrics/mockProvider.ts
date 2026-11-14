import type {
  BiometricReading,
  BiometricsListener,
  BiometricsProvider,
  BiometricsStartOptions,
} from './types';

/** Deterministic display-only series. It never accesses camera images or a network. */
export class MockBiometricsProvider implements BiometricsProvider {
  readonly mode = 'mock' as const;

  private listeners = new Set<BiometricsListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: BiometricReading | null = null;
  private tick = 0;

  async start({ consent }: BiometricsStartOptions): Promise<void> {
    if (!consent) {
      throw new Error('请先同意摄像头图像分析，才能开启演示面板。');
    }
    this.stop();
    this.tick = 0;
    this.publishNext();
    this.timer = setInterval(() => this.publishNext(), 3000);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLatestReading(): BiometricReading | null {
    return this.latest;
  }

  subscribe(listener: BiometricsListener): void {
    this.listeners.add(listener);
  }

  unsubscribe(listener: BiometricsListener): void {
    this.listeners.delete(listener);
  }

  private publishNext(): void {
    const phase = this.tick;
    const emotions = [
      { label: '平静', confidence: 0.82 },
      { label: '专注', confidence: 0.77 },
      { label: '专注', confidence: 0.81 },
      { label: '轻微紧张', confidence: 0.69 },
      { label: '平静', confidence: 0.79 },
    ];
    const reading: BiometricReading = {
      timestamp: Date.now(),
      source: 'mock',
      heartRateBpm: Math.round(76 + 5 * Math.sin(phase * 0.58) + 2 * Math.cos(phase * 0.27)),
      emotion: emotions[Math.floor(phase / 2) % emotions.length],
      signalQuality: phase % 9 === 7 ? 'fair' : 'good',
      extraMetrics: { respirationRate: Math.round(16 + 2 * Math.sin(phase * 0.38)) },
    };
    this.latest = reading;
    this.tick += 1;
    this.listeners.forEach((listener) => listener(reading));
  }
}
