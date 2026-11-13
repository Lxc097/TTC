import { ApiBiometricsProvider } from './apiProvider';
import { MockBiometricsProvider } from './mockProvider';
import type { BiometricsMode, BiometricsProvider } from './types';

export * from './types';
export { ApiBiometricsProvider, MockBiometricsProvider };

export function createBiometricsProvider(mode: BiometricsMode): BiometricsProvider {
  return mode === 'api' ? new ApiBiometricsProvider() : new MockBiometricsProvider();
}
