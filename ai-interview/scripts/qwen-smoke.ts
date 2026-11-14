import { createChatCompletion, getQwenConfig } from '../server/qwen'

const config = getQwenConfig()
if (!config.apiKey) {
  console.error('DASHSCOPE_API_KEY 未设置；冒烟测试未发起请求。')
  process.exitCode = 1
} else {
  try {
    const response = await createChatCompletion(config, [
      { role: 'user', content: '请只用简体中文回复：连接正常。' },
    ], 48)
    const reply = response.choices?.[0]?.message?.content?.trim()
    if (!reply) throw new Error('阿里云百炼没有返回回复内容。')
    console.log('回复：' + reply)
    console.log('prompt_tokens：' + (response.usage?.prompt_tokens ?? '未返回'))
    console.log('completion_tokens：' + (response.usage?.completion_tokens ?? '未返回'))
  } catch (error) {
    console.error(error instanceof Error ? error.message : '阿里云百炼冒烟测试失败。')
    process.exitCode = 1
  }
}
