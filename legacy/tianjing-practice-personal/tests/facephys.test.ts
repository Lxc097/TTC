import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { analyzeFacePhysVideo, mapFacePhysResponse, type FacePhysConfig } from '../server/facephys'
import { describeQuestionReaction } from '../src/utils/answerInsight'

const config: FacePhysConfig = {
  baseUrl: 'https://www.facephys.com',
  keyId: 'test-key-id',
  secretKey: 'test-secret',
}

test('FacePhys V3 request signs presign and process without sending credentials in the response', async () => {
  const original = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      if (calls.length === 1) return new Response(JSON.stringify({
        uploadUrl: 'https://oss.example.test/clip%2Ftest?signature=temporary',
        objectKey: 'clip/test',
      }), { status: 200 })
      if (calls.length === 2) return new Response(null, { status: 200 })
      return new Response(JSON.stringify({
        data: { cardiac: { hr: 74, sqi: 0.82, hr_list: [{ hr: 72, ts: 0 }, { hr: 74, ts: 1 }] } },
        video_duration: 30,
      }), { status: 200 })
    }
    const result = await analyzeFacePhysVideo(new Uint8Array([1, 2, 3]), 'video/webm', config)
    assert.equal(calls.length, 3)
    assert.equal(calls[0].url, 'https://www.facephys.com/api/v2/video/upload/presign')
    assert.equal(calls[1].url, 'https://oss.example.test/clip/test?signature=temporary')
    assert.equal(new Headers(calls[1].init?.headers).get('Content-Type'), 'video/mp4')
    assert.equal(calls[2].url, 'https://www.facephys.com/api/v3/video/process')
    const first = new Headers(calls[0].init?.headers)
    const third = new Headers(calls[2].init?.headers)
    for (const headers of [first, third]) {
      const timestamp = headers.get('x-timestamp') || ''
      assert.equal(headers.get('x-key-id'), config.keyId)
      assert.equal(headers.get('x-signature'), createHmac('sha256', config.secretKey).update(timestamp).digest('base64'))
      assert.match(headers.get('user-agent') || '', /^Mozilla\/5\.0 /)
    }
    assert.equal(result.source, 'api')
    assert.deepEqual(result.readings.map(reading => reading.heartRateBpm), [72, 74])
    assert.equal(result.readings[0].signalQuality, 'good')
    assert.equal(JSON.stringify(result).includes(config.secretKey), false)
  } finally { globalThis.fetch = original }
})

test('FacePhys mapping tolerates unavailable modules and never manufactures emotion', () => {
  const result = mapFacePhysResponse({ data: { cardiac: { hr: 81.5, sqi: 0.2 } } }, 1000)
  assert.equal(result.readings.length, 1)
  assert.equal(result.readings[0].heartRateBpm, 81.5)
  assert.equal(result.readings[0].signalQuality, 'fair')
  assert.equal(result.readings[0].emotion, null)
  const unusable = mapFacePhysResponse({
    data: { cardiac: { hr: 81.5, sqi: 0.1 }, emotion: { surface: { happy: 0.9 } } },
  }, 1000)
  assert.equal(unusable.readings[0].heartRateBpm, null)
  assert.equal(unusable.readings[0].emotion, null)
})

test('FacePhys raw analysis retains measured fields while hiding transport and credentials', () => {
  const result = mapFacePhysResponse({
    data: {
      cardiac: { hr: 75, sqi: 0.8, hr_list: [{ hr: 75, ts: 0 }] },
      breathing_rate: 16,
      liveness: { is_live: true, liveness_score: 0.9 },
      uploadUrl: 'https://example.test/private-video',
      secretKey: config.secretKey,
      note: 'provider says ' + config.keyId,
    },
  }, 1000, config)
  assert.equal((result.rawData.cardiac as { hr: number }).hr, 75)
  assert.equal(result.rawData.breathing_rate, 16)
  assert.equal((result.rawData.liveness as { is_live: boolean }).is_live, true)
  const raw = JSON.stringify(result.rawData)
  assert.equal(raw.includes(config.keyId), false)
  assert.equal(raw.includes(config.secretKey), false)
  assert.equal(raw.includes('private-video'), false)
})

test('question cue requires prior personal samples and keeps mock provenance', () => {
  const reading = { timestamp: 3000, source: 'api' as const, heartRateBpm: 99, emotion: null, signalQuality: 'good' as const }
  assert.equal(describeQuestionReaction(reading).label, '个人参考值建立中')
  const previous = [
    { ...reading, timestamp: 1000, heartRateBpm: 76 },
    { ...reading, timestamp: 2000, heartRateBpm: 78 },
  ]
  assert.equal(describeQuestionReaction(reading, previous).label, '相对参考值升高')
  assert.equal(describeQuestionReaction({ ...reading, source: 'mock' }).source, 'mock')
})

test('FacePhys missing credentials prevents all network activity', async () => {
  const original = globalThis.fetch
  let called = false
  try {
    globalThis.fetch = async () => { called = true; throw new Error('request should not happen') }
    await assert.rejects(
      () => analyzeFacePhysVideo(new Uint8Array([1]), 'video/webm', { ...config, secretKey: '' }),
      /FACEPHYS_KEY_ID 或 FACEPHYS_SECRET_KEY 未设置/,
    )
    assert.equal(called, false)
  } finally { globalThis.fetch = original }
})
