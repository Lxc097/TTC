import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { analyzeFacePhysVideo, mapFacePhysResponse, type FacePhysConfig } from '../server/facephys'

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
  assert.equal(result.readings[0].signalQuality, 'poor')
  assert.equal(result.readings[0].emotion, null)
  const unusable = mapFacePhysResponse({
    data: { cardiac: { hr: 81.5, sqi: 0.1 }, emotion: { surface: { happy: 0.9 } } },
  }, 1000)
  assert.equal(unusable.readings[0].heartRateBpm, null)
  assert.equal(unusable.readings[0].emotion, null)
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
