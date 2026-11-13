import assert from 'node:assert/strict'
import test from 'node:test'
import { createQuestionPlan } from '../src/services/interviewEngine'
import { INITIAL_INTERVIEW_FLOW, interviewFlowReducer } from '../src/hooks/interviewFlow'
import { shouldStartAutoSubmit } from '../src/utils/autoSubmit'
import { generateInterviewReport } from '../src/utils/report'
import type { InterviewConfig } from '../src/types/interview'

test('岗位、难度和时长改变实际题目计划', () => {
  const config: InterviewConfig = { targetRole: '前端工程师', role: 'frontend', type: 'general', difficulty: 'basic', durationMinutes: 5 }
  const short = createQuestionPlan(config)
  assert.equal(short.length, 3)
  assert.ok(short.every(question => question.role === 'frontend'))
  assert.notEqual(short[0].prompt, createQuestionPlan({ ...config, difficulty: 'challenge' })[0].prompt)
  assert.notEqual(short[0].prompt, createQuestionPlan({ ...config, role: 'backend' })[0].prompt)
  assert.equal(createQuestionPlan({ ...config, durationMinutes: 15 }).length, 7)
})

test('面试阶段按真实事件迁移，完成后不再接受新事件', () => {
  const speaking = interviewFlowReducer(INITIAL_INTERVIEW_FLOW, { type: 'SPEECH_STARTED' })
  assert.equal(speaking.phase, 'speaking')
  const ready = interviewFlowReducer(speaking, { type: 'SPEECH_ENDED' })
  const listening = interviewFlowReducer(ready, { type: 'LISTEN_STARTED' })
  assert.equal(listening.phase, 'listening')
  const thinking = interviewFlowReducer(listening, { type: 'SUBMIT_STARTED' })
  assert.equal(thinking.phase, 'thinking')
  assert.equal(interviewFlowReducer(thinking, { type: 'SPEECH_STARTED' }).phase, 'thinking')
  const followUp = interviewFlowReducer(thinking, { type: 'FOLLOW_UP', prompt: '请给出证据。' })
  assert.equal(followUp.followUpCount, 1)
  assert.equal(followUp.followUpPrompt, '请给出证据。')
  const completed = interviewFlowReducer(followUp, { type: 'FINISH' })
  assert.equal(interviewFlowReducer(completed, { type: 'NEXT_QUESTION' }).phase, 'completed')
})

test('自动完成只在有效转写、12 秒回答和 8 秒静音后启动', () => {
  const base = { enabled: true, phase: 'listening' as const, firstVoiceAt: 0, lastVoiceAt: 4_000, now: 12_000, hasText: true }
  assert.equal(shouldStartAutoSubmit(base), true)
  assert.equal(shouldStartAutoSubmit({ ...base, now: 11_999 }), false)
  assert.equal(shouldStartAutoSubmit({ ...base, lastVoiceAt: 4_001 }), false)
  assert.equal(shouldStartAutoSubmit({ ...base, hasText: false }), false)
  assert.equal(shouldStartAutoSubmit({ ...base, enabled: false }), false)
  assert.equal(shouldStartAutoSubmit({ ...base, phase: 'speaking' }), false)
})

test('AI 主题词允许组成词分散出现，仍保持可解释评分', () => {
  const config: InterviewConfig = { targetRole: '前端工程师', role: 'frontend', type: 'technical', difficulty: 'basic', durationMinutes: 5 }
  const report = generateInterviewReport({
    id: 'test-report', config, startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z', elapsedSeconds: 60,
    questions: [{ id: 'ai-1', role: 'frontend', type: 'technical', difficulty: 'basic', prompt: '如何定位渲染性能？', keywords: ['React Profiler', '性能分析'], followUps: [] }],
    answers: [{ questionId: 'ai-1', prompt: '如何定位渲染性能？', answer: '我在 React 中使用 Profiler 对组件做性能分析，再查看提交时间。', startedAt: '2026-01-01T00:00:00Z', answeredAt: '2026-01-01T00:01:00Z', durationSeconds: 60, inputMode: 'text' }],
  })
  assert.equal(report.keywordScore, 100)
  assert.deepEqual(report.questionFeedback[0].matchedKeywords, ['React Profiler', '性能分析'])
})
