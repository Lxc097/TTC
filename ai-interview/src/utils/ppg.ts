/** Small, local-only optical samples from the existing camera preview. */
export interface PulseSample {
  at: number
  value: number
}

/**
 * Estimate a periodic component only after a sustained, reasonably stable signal.
 * A null result must be shown as unavailable rather than replaced with a demo BPM.
 */
export function estimatePulseBpm(samples: PulseSample[]): number | null {
  const end = samples.at(-1)?.at
  if (end === undefined) return null
  const recent = samples.filter(sample => sample.at >= end - 20_000)
  if (recent.length < 180 || end - recent[0].at < 15_000) return null
  if (recent.some((sample, index) => index > 0 && sample.at - recent[index - 1].at > 450)) return null

  const times = recent.map(sample => (sample.at - recent[0].at) / 1000)
  const values = recent.map(sample => sample.value)
  const meanTime = times.reduce((sum, value) => sum + value, 0) / times.length
  const meanValue = values.reduce((sum, value) => sum + value, 0) / values.length
  let covariance = 0
  let timeVariance = 0
  for (let index = 0; index < times.length; index += 1) {
    covariance += (times[index] - meanTime) * (values[index] - meanValue)
    timeVariance += (times[index] - meanTime) ** 2
  }
  const slope = timeVariance > 0 ? covariance / timeVariance : 0
  const residual = values.map((value, index) => value - meanValue - slope * (times[index] - meanTime))
  const variance = residual.reduce((sum, value) => sum + value * value, 0) / residual.length
  if (variance < 0.00000001) return null

  let bestBpm = 0
  let bestStrength = 0
  const strengths: number[] = []
  for (let bpm = 48; bpm <= 150; bpm += 1) {
    const frequency = bpm / 60
    let cosine = 0
    let sine = 0
    for (let index = 0; index < recent.length; index += 1) {
      const phase = 2 * Math.PI * frequency * times[index]
      cosine += residual[index] * Math.cos(phase)
      sine += residual[index] * Math.sin(phase)
    }
    const strength = 2 * (cosine * cosine + sine * sine) / (recent.length ** 2 * variance)
    strengths.push(strength)
    if (strength > bestStrength) {
      bestStrength = strength
      bestBpm = bpm
    }
  }
  const sorted = strengths.slice().sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] || 0
  if (bestStrength < 0.42 || bestStrength < median * 4) return null
  return bestBpm
}

/** Draw the measured colour variation itself; an empty signal stays flat. */
export function pulseWaveformPath(samples: PulseSample[]): string {
  const recent = samples.slice(-110)
  if (recent.length < 2) return 'M 0 42 L 600 42'
  const mean = recent.reduce((sum, sample) => sum + sample.value, 0) / recent.length
  const offsets = recent.map(sample => sample.value - mean)
  const peak = Math.max(0.0002, ...offsets.map(value => Math.abs(value)))
  const firstX = 600 - (recent.length - 1) * (600 / 109)
  return recent.map((_, index) => {
    const x = firstX + index * (600 / 109)
    const y = Math.max(9, Math.min(75, 42 - offsets[index] / peak * 26))
    return (index === 0 ? 'M ' : 'L ') + x.toFixed(1) + ' ' + y.toFixed(1)
  }).join(' ')
}
