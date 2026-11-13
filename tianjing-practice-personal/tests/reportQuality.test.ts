import assert from 'node:assert/strict'
import test from 'node:test'
import { generateInterviewReport } from '../src/utils/report'
import { localAnswerSummary } from '../src/utils/answerInsight'
import type { InterviewAnswer, InterviewConfig, InterviewQuestion } from '../src/types/interview'

const config = { role: 'frontend', targetRole: '前端工程师', type: 'technical', difficulty: 'standard', durationMinutes: 5 } as InterviewConfig
const question: InterviewQuestion = {
  id: 'ai-quality', role: 'frontend', type: 'technical', difficulty: 'standard',
  prompt: '如何定位 React 页面渲染性能并验证优化效果？',
  keywords: ['React Profiler', '性能分析', '验证效果'], followUps: [],
}
function evaluate(text: string) {
  const answer: InterviewAnswer = {
    questionId: question.id, prompt: question.prompt, answer: text,
    startedAt: '2026-11-14T00:00:00Z', answeredAt: '2026-11-14T00:01:00Z',
    durationSeconds: 60, inputMode: 'text',
  }
  return generateInterviewReport({
    id: 'report-quality', config, questions: [question], answers: [answer],
    startedAt: answer.startedAt, endedAt: answer.answeredAt, elapsedSeconds: 60,
  }).questionFeedback[0]
}

test('空白和单字符没有无依据的能力评价', () => {
  const blank = evaluate('')
  const one = evaluate('1')
  assert.equal(blank.score, 0)
  assert.equal(one.score, 0)
  assert.match(one.suggestions.join(' '), /无法判断相关能力/)
  assert.match(localAnswerSummary('1'), /无法判断相关能力/)
})

test('跑题、简单描述与有证据回答产生不同建议', () => {
  const unrelated = evaluate('周末我在公园散步，天气很好，还和朋友一起吃了晚饭。')
  const simple = evaluate('我会先查看 React 页面渲染，再考虑怎么优化。')
  const strong = evaluate('我在项目中负责 React 页面性能分析，先用 React Profiler 定位重复渲染的组件，再比较改动前后的提交耗时；最后通过测试验证效果，并记录真实监控数据。')
  assert.ok(unrelated.score <= 35)
  assert.match(unrelated.suggestions.join(' '), /未直接回应本题主题/)
  assert.ok(simple.score > unrelated.score)
  assert.match(simple.suggestions.join(' '), /你已说明|你提到/)
  assert.ok(strong.score > simple.score)
  assert.ok(strong.matchedKeywords.length >= 2)
  assert.notDeepEqual(strong.suggestions, simple.suggestions)
})

test('已说明技术行动和验证时不再要求重新补行动', () => {
  const planningQuestion: InterviewQuestion = { ...question, id: 'ai-planning',
    prompt: '接到一项新任务时，你如何规划步骤、安排优先级并跟进进度？',
    keywords: ['目标拆解', '优先级', '进度跟踪'],
  }
  const text = '我负责串口通信模块，先用日志定位丢包，再调整缓冲区并通过连续测试验证。'
  const answer: InterviewAnswer = {
    questionId: planningQuestion.id, prompt: planningQuestion.prompt, answer: text,
    startedAt: '2026-11-14T00:00:00Z', answeredAt: '2026-11-14T00:01:00Z',
    durationSeconds: 60, inputMode: 'text',
  }
  const feedback = generateInterviewReport({
    id: 'report-planning', config, questions: [planningQuestion], answers: [answer],
    startedAt: answer.startedAt, endedAt: answer.answeredAt, elapsedSeconds: 60,
  }).questionFeedback[0]
  const advice = feedback.suggestions.join(' ') + localAnswerSummary(text)
  assert.match(advice, /已描述|已说明/)
  assert.match(advice, /具体行动|验证/)
  assert.match(advice, /决策顺序|题目要求/)
  assert.match(advice, /实际测得的结果|量化变化|实际结果/)
  assert.doesNotMatch(advice, /请补充你亲自采取的行动|没有直接回应本题主题/)
})

test('FacePhys 原始批次保留来源与时间且不改变文本评分', () => {
  const answer: InterviewAnswer = {
    questionId: question.id, prompt: question.prompt, answer: '我用 React Profiler 做性能分析，再用测试验证效果。',
    startedAt: '2026-11-14T00:00:00Z', answeredAt: '2026-11-14T00:01:00Z',
    durationSeconds: 60, inputMode: 'text',
  }
  const base = { id: 'raw-report', config, questions: [question], answers: [answer],
    startedAt: answer.startedAt, endedAt: answer.answeredAt, elapsedSeconds: 60 }
  const without = generateInterviewReport(base)
  const withRaw = generateInterviewReport({ ...base, biometrics: { mode: 'api', status: 'complete', samples: [], rawBatches: [{
    capturedAt: '2026-11-14T00:00:20Z', receivedAt: '2026-11-14T00:00:55Z',
    videoDurationSeconds: 30, rawData: { cardiac: { hr: 82, sqi: 0.4 } },
  }] } })
  assert.equal(withRaw.overallScore, without.overallScore)
  assert.equal(withRaw.questionFeedback[0].score, without.questionFeedback[0].score)
})
