/** All readings carry their provenance so demo data cannot be mistaken for measurement. */
export type BiometricsMode = 'mock' | 'api';

export type SignalQuality = 'good' | 'fair' | 'poor' | 'unavailable';

export interface EmotionEstimate {
  label: string;
  /** A provider's confidence, between 0 and 1. This is not a clinical score. */
  confidence: number;
}

export interface BiometricReading {
  timestamp: number;
  source: BiometricsMode;
  heartRateBpm: number | null;
  emotion: EmotionEstimate | null;
  signalQuality: SignalQuality;
  /** Provider-specific future fields; never used as an interview ability score. */
  extraMetrics?: Record<string, number | string | boolean | null>;
}

export interface BiometricsStartOptions {
  consent: boolean;
  videoElement?: HTMLVideoElement | null;
}

export type BiometricsListener = (reading: BiometricReading) => void;

export interface BiometricsProvider {
  readonly mode: BiometricsMode;
  start(options: BiometricsStartOptions): Promise<void>;
  stop(): void;
  getLatestReading(): BiometricReading | null;
  subscribe(listener: BiometricsListener): void;
  unsubscribe(listener: BiometricsListener): void;
}
