import { getQuestionById } from '../services/interviewEngine'
import type { InterviewAnswer, InterviewConfig, InterviewQuestion, InterviewRecord, InterviewReport, QuestionFeedback } from '../types/interview'

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)))
const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0
const normalized = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, '').replace(/[^\p{L}\p{N}]/gu, '')
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })

function matchesKeyword(text: string, group: string): boolean {
  const haystack = normalized(text)
  return group.split('|').some(alternative => {
    const exact = normalized(alternative)
    if (exact && haystack.includes(exact)) return true
    const parts = Array.from(segmenter.segment(alternative))
      .filter(item => item.isWordLike)
      .map(item => normalized(item.segment))
      .filter(item => item.length >= 2)
    return parts.length >= 2 && parts.every(part => haystack.includes(part))
  })
}

function topicTerms(prompt: string): string[] {
  const stop = new Set(['请问', '请你', '如何', '什么', '一个', '一次', '说明', '介绍', '以及', '如果', '现在', '哪些', '怎样', '为什么'])
  return Array.from(segmenter.segment(prompt))
    .filter(item => item.isWordLike)
    .map(item => normalized(item.segment))
    .filter(item => item.length >= 2 && !stop.has(item))
    .slice(0, 18)
}

function answerIsQuestionCopy(answer: string, prompt: string): boolean {
  const text = normalized(answer)
  const question = normalized(prompt)
  return text.length >= 8 && (question.includes(text) || (text.includes(question) && question.length / text.length >= 0.65))
}

function roleEvidence(config: InterviewConfig): string {
  const custom = (config as InterviewConfig & { targetRole?: string }).targetRole?.trim() || config.targetRoleDescription?.trim() || ''
  const role = custom + ' ' + config.role
  if (/产品|需求|用户|product/i.test(role)) return '目标用户、需求取舍、优先级依据和验证指标'
  if (/运营|市场|增长|投放|marketing/i.test(role)) return '目标人群、渠道选择、投入产出和复盘指标'
  if (/工程|开发|技术|算法|模型|嵌入式|测试|运维|前端|后端|frontend|backend/i.test(role)) return '方案取舍、本人负责的实现、可靠性或性能验证'
  return '你采取的行动、选择依据和可核实的结果'
}

function shortQuote(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > 42 ? compact.slice(0, 42) + '…' : compact
}

function evaluate(answer: InterviewAnswer, questions: InterviewQuestion[] | undefined, config: InterviewConfig): QuestionFeedback {
  const text = answer.answer.trim()
  const characters = text.replace(/\s/g, '').length
  const baseId = answer.questionId.replace(/-followup(?:-\d+)?$/, '')
  const question = questions?.find(item => item.id === baseId) ?? getQuestionById(answer.questionId)
  const keywordGroups = question?.keywords ?? []
  const matchedKeywords = keywordGroups.filter(group => matchesKeyword(text, group))
  const missingKeywords = keywordGroups.filter(group => !matchedKeywords.includes(group))
  const matched = matchedKeywords.map(group => group.split('|')[0])
  const missing = missingKeywords.map(group => group.split('|')[0])
  const isEmpty = !text
  const isNoise = !isEmpty && (characters < 8 || !/[\p{L}]/u.test(text) || answerIsQuestionCopy(text, answer.prompt))
  const answerTerms = normalized(text)
  const terms = topicTerms(answer.prompt)
  const weakRelation = !isEmpty && !isNoise && keywordGroups.length >= 2 && matched.length === 0
    && terms.length > 0 && !terms.some(term => answerTerms.includes(term))
  const hasAction = /负责|设计|实现|排查|定位|调整|优化|推动|协调|测试|验证|采用|选择|拆解|分析|交付|解决|我做|我会|I (?:built|used|tested)/i.test(text)
  const hasEvidence = /项目|用户|数据|指标|案例|例如|比如|实验|测试|日志|监控|反馈|结果|提升|下降|耗时|比例|%|证据|复盘/i.test(text)
  const hasSequence = /首先|其次|然后|最后|第一|第二|先.{0,6}再|因为.{0,30}所以|first|second/i.test(text)
  const hasVerification = /验证|测试|日志|监控|实验|复盘|核对/i.test(text)
  const hasResult = /结果|上线|改善|提升|下降|减少|增加|达到|完成了|实现了|\d+(?:\.\d+)?\s*(?:%|倍|毫秒|秒|次|人|元)/i.test(text)
  const sentences = text.split(/[。！？!?;；\n]+/).map(part => part.trim()).filter(Boolean).length
  let completenessScore = 0
  let keywordScore = 0
  let structureScore = 0
  let score = 0
  const suggestions: string[] = []
  let category: string

  if (isEmpty) {
    category = '未作答'
    suggestions.push('本题没有回答。请先针对题目给出一句明确结论，再补充你亲自做过的事实。')
  } else if (isNoise) {
    category = '无有效评价信息'
    suggestions.push('本次回答未包含可用于评价该问题的信息，无法判断相关能力表现。请重新回答题目本身。')
    suggestions.push('可以先说明' + roleEvidence(config) + '，只填写真实经历，不编造结果。')
  } else {
    completenessScore = clamp(Math.min(characters, 140) / 140 * 75 + (hasAction ? 12 : 0) + (hasResult ? 13 : 0))
    keywordScore = keywordGroups.length ? clamp(matched.length / keywordGroups.length * 100) : 50
    structureScore = clamp(Math.min(characters, 80) / 80 * 35 + (sentences >= 2 ? 15 : 0)
      + (hasSequence ? 15 : 0) + (hasAction ? 15 : 0) + (hasEvidence ? 10 : 0) + (hasResult ? 10 : 0))
    score = clamp(completenessScore * 0.4 + keywordScore * 0.35 + structureScore * 0.25)
    if (weakRelation) {
      category = '题目关联证据不足'
      score = Math.min(score, 35)
      suggestions.push(hasAction
        ? '你已描述“' + shortQuote(text) + '”中的具体行动' + (hasVerification ? '和验证方式' : '') + '；但尚未说明这些步骤如何回应当前题目的核心要求。请补充与本题相关的决策顺序及依据。'
        : '回答“' + shortQuote(text) + '”尚未直接回应本题主题；请先明确回应题目，再说明相关事实。')
      if (hasAction && hasVerification && !hasResult) suggestions.push('你已说明如何验证，但尚未交代实际测得的结果或量化变化；如有真实数据，请补充，不要编造。')
    } else if (characters < 40) {
      category = '有内容但展开不足'
      score = Math.min(score, 55)
      suggestions.push(hasAction
        ? '你已说明“' + shortQuote(text) + '”中的具体行动' + (hasVerification ? '和验证方式' : '') + '；请补充与题目的关联、选择依据和实际测得的结果（如有）。'
        : '你提到“' + shortQuote(text) + '”，但尚未说明具体行动；请补充' + roleEvidence(config) + '。')
    } else {
      category = hasAction && hasResult ? '有行动与结果线索' : '有实际内容'
      if (hasAction && !hasResult) suggestions.push('你已描述“' + shortQuote(text) + '”中的行动' + (hasVerification ? '和验证步骤' : '') + '；请补充验证得到的实际结果或量化变化，不要编造数字。')
      else if (!hasAction) suggestions.push('回答已涉及“' + shortQuote(text) + '”，请进一步交代' + roleEvidence(config) + '。')
      else if (!hasEvidence) suggestions.push('你已描述行动和结果；下次可补充真实数据或可核对的验证方法，不要凭空补数字。')
    }
    if (missing.length) suggestions.push('本题尚未明确覆盖“' + missing.slice(0, 2).join('、') + '”；如果与你的经历有关，请说明具体做法或取舍。')
    if (hasAction && hasResult && matched.length && !suggestions.length) suggestions.push('已回应题目并提供行动、结果线索；保持这些真实细节，可进一步精简开头。')
    if (!suggestions.length) suggestions.push('围绕题目补充一个可核实的实际例子，并说明你在其中负责的部分。')
  }

  return {
    questionId: answer.questionId, prompt: answer.prompt, answer: text,
    completenessScore, keywordScore, structureScore, score,
    matchedKeywords: matched, missingKeywords: missing,
    suggestions: suggestions.slice(0, 3),
    explanation: category + '。回答 ' + characters + ' 字；覆盖 ' + matched.length + '/' + keywordGroups.length
      + ' 组题目主题词；' + (hasAction ? '有行动描述' : '未见明确行动描述') + '、'
      + (hasVerification ? '有验证步骤' : '未见验证步骤') + '、'
      + (hasResult ? '有结果线索' : '未见具体结果')
      + '。本地规则仅评估文本证据，不推断未出现的经历或能力。',
  }
}

/** Physiological readings are deliberately excluded from all answer scores. */
export function generateInterviewReport(record: Omit<InterviewRecord, 'report'>): InterviewReport {
  const questionFeedback = record.answers.map(answer => evaluate(answer, record.questions, record.config))
  const completenessScore = average(questionFeedback.map(item => item.completenessScore))
  const keywordScore = average(questionFeedback.map(item => item.keywordScore))
  const structureScore = average(questionFeedback.map(item => item.structureScore))
  const overallScore = average(questionFeedback.map(item => item.score))
  const substantive = questionFeedback.filter(item => item.score > 0)
  const strongest = substantive.slice().sort((a, b) => b.score - a.score)[0]
  const weakest = questionFeedback.slice().sort((a, b) => a.score - b.score)[0]
  const strengths = strongest
    ? ['在“' + strongest.prompt.slice(0, 24) + '…”中，你提供了可供复盘的回答内容；已覆盖 ' + strongest.matchedKeywords.length + ' 个题目主题。']
    : ['本次没有足以评价岗位能力的回答，报告不会推断未被回答证明的表现。']
  const improvements = weakest
    ? [weakest.suggestions[0]]
    : ['选择一道与你的真实经历相关的问题，先完成一次具体作答。']
  const nextSteps = weakest
    ? ['重练“' + weakest.prompt.slice(0, 28) + '…”：' + weakest.suggestions[0]]
    : ['从熟悉的经历开始，练习说明自己的行动及其验证方式。']
  const realSamples = record.biometrics?.mode === 'api'
    ? record.biometrics.samples.filter(sample => typeof sample.heartRateBpm === 'number'
      && Number.isFinite(sample.heartRateBpm) && sample.heartRateBpm >= 40 && sample.heartRateBpm <= 180
      && (sample.signalQuality === 'good' || sample.signalQuality === 'fair')
      && sample.reaction?.source !== 'mock') : []
  const averageHeartRate = realSamples.length >= 2
    ? Math.round(realSamples.reduce((sum, sample) => sum + (sample.heartRateBpm as number), 0) / realSamples.length) : null
  const linkedIndex = record.answers.findIndex(answer => realSamples.some(sample => sample.roundKey === answer.roundKey))
  const linkedAnswer = linkedIndex >= 0 ? record.answers[linkedIndex] : undefined
  const linkedFeedback = linkedIndex >= 0 ? questionFeedback[linkedIndex] : undefined
  const multimodalSummary = averageHeartRate === null ? undefined
    : 'FacePhys 返回 ' + realSamples.length + ' 条有效心率采样，本次平均估计心率约 ' + averageHeartRate
      + ' BPM。' + (linkedAnswer && linkedFeedback
        ? '其中与“' + linkedAnswer.prompt.slice(0, 24) + '…”同时段的最终回答'
          + (linkedAnswer.answer.trim() ? '提到“' + shortQuote(linkedAnswer.answer) + '”，文本覆盖 ' + linkedFeedback.matchedKeywords.length + ' 组题目主题词。' : '没有可评价的文字内容。')
        : '部分采样无法可靠归入具体题目，因此不做逐题推断。')
      + '这些是时间关联的独立观察，不能用心率推断紧张、自信或专业能力。'

  return {
    overallScore, completenessScore, keywordScore, structureScore, questionFeedback, multimodalSummary,
    strengths, improvements, nextSteps,
    scoringMethod: '本地可解释规则：先判定空白、无效或关联不足，再按回答完整度 40%、题目主题词覆盖 35%、表达结构与事实线索 25% 计算。无效回答记 0，关联不足上限 35；所有建议只依据真实回答文本。FacePhys 不参与评分。',
  }
}
