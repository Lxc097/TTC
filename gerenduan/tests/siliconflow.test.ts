import assert from 'node:assert/strict'
import test from 'node:test'
import { createChatCompletion, SiliconFlowError, type SiliconFlowConfig } from '../server/siliconflow'
import { parseGeneratedQuestions } from '../server/questionPlan'

const config: SiliconFlowConfig = {
  baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'deepseek-ai/DeepSeek-V4.1-Flash',
  apiKey: 'test-secret',
}
const messages = [{ role: 'user' as const, content: '你好' }]

test('结构化 AI 题目必须完整且含可解释的主题词', () => {
  const valid = JSON.stringify([
    { prompt: '请介绍一个你优化页面性能的经历，以及验证结果。', keywords: ['性能', '指标'] },
    { prompt: '如果移动端页面加载变慢，你会如何定位原因？', keywords: ['定位', '网络'] },
    { prompt: '跨团队优先级冲突时，你如何安排交付顺序？', keywords: ['优先级', '沟通'] },
  ])
  assert.equal(parseGeneratedQuestions(valid, 3)?.length, 3)
  assert.equal(parseGeneratedQuestions(valid, 5), null)
  assert.equal(parseGeneratedQuestions('[{"prompt":"不完整","keywords":[]}]', 1), null)
})

test('兼容请求保留 /v1 并读取回复与 usage', async () => {
  const original = globalThis.fetch
  let calledUrl = ''
  let body: Record<string, unknown> | null = null
  try {
    globalThis.fetch = async (input, init) => {
      calledUrl = String(input)
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        choices: [{ message: { content: '连接正常。' } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }), { status: 200 })
    }
    const result = await createChatCompletion(config, messages, 48)
    assert.equal(calledUrl, 'https://api.siliconflow.cn/v1/chat/completions')
    assert.equal(body?.model, config.model)
    assert.equal(result.choices?.[0]?.message?.content, '连接正常。')
    assert.equal(result.usage?.prompt_tokens, 3)
    assert.equal(result.usage?.completion_tokens, 4)
  } finally { globalThis.fetch = original }
})

test('401、404、429、503 均保留安全的上游错误说明', async () => {
  const original = globalThis.fetch
  try {
    for (const status of [401, 404, 429, 503]) {
      globalThis.fetch = async () => new Response(JSON.stringify({
        error: { message: '上游详情 ' + config.apiKey },
      }), { status })
      await assert.rejects(
        () => createChatCompletion(config, messages, 48),
        error => error instanceof SiliconFlowError
          && error.status === status
          && error.message.includes(String(status))
          && error.message.includes('上游详情')
          && !error.message.includes(config.apiKey),
      )
    }
  } finally { globalThis.fetch = original }
})

test('缺少密钥时不发起网络请求', async () => {
  const original = globalThis.fetch
  let called = false
  try {
    globalThis.fetch = async () => { called = true; throw new Error('不应请求') }
    await assert.rejects(() => createChatCompletion({ ...config, apiKey: '' }, messages, 48), /SILICONFLOW_API_KEY 未设置/)
    assert.equal(called, false)
  } finally { globalThis.fetch = original }
})
