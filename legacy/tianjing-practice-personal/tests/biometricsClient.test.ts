import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiBiometricsProvider } from '../src/services/biometrics/apiProvider'
import { generateInterviewReport } from '../src/utils/report'
import type { InterviewRecord } from '../src/types/interview'

test('FacePhys provider never calls the network without image-analysis consent', async () => {
  const originalFetch = globalThis.fetch
  let called = false
  try {
    globalThis.fetch = async () => { called = true; throw new Error('network should not be called') }
    const provider = new ApiBiometricsProvider()
    await assert.rejects(() => provider.start({ consent: false }), /未获得图像分析授权/)
    assert.equal(called, false)
  } finally { globalThis.fetch = originalFetch }
})

test('formal report synthesizes only actual FacePhys samples, never historical mock values', () => {
  const base: Omit<InterviewRecord, 'report'> = {
    id: 'test', config: { targetRole: '嵌入式开发工程师', role: 'general', type: 'technical', difficulty: 'standard', durationMinutes: 5 },
    startedAt: '2026-11-14T00:00:00Z', endedAt: '2026-11-14T00:01:00Z', elapsedSeconds: 60,
    answers: [{ questionId: 'q1', roundKey: '0:0', prompt: '如何定位丢包？', answer: '我用日志定位丢包，并通过连续测试验证。', startedAt: '2026-11-14T00:00:00Z', answeredAt: '2026-11-14T00:01:00Z', durationSeconds: 60, inputMode: 'text' }],
  }
  const samples = [72, 74].map((heartRateBpm, index) => ({
    timestamp: `2026-11-14T00:00:0${index}Z`, heartRateBpm, signalQuality: 'good', roundKey: '0:0',
    reaction: { label: '相对参考值平稳', detail: '仅供观察', source: 'facephys' as const },
  }))
  assert.equal(generateInterviewReport({ ...base, biometrics: { mode: 'mock', samples } }).multimodalSummary, undefined)
  assert.match(generateInterviewReport({ ...base, biometrics: { mode: 'api', samples } }).multimodalSummary || '', /FacePhys 返回 2 条有效心率采样/)
})
