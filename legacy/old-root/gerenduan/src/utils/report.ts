import { getQuestionById } from '../services/interviewEngine'
import type { InterviewAnswer, InterviewQuestion, InterviewRecord, InterviewReport, QuestionFeedback } from '../types/interview'

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)))
const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0
const normalized = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, '')
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

function evaluate(answer: InterviewAnswer, questions?: InterviewQuestion[]): QuestionFeedback {
  const text = answer.answer.trim()
  const characters = text.replace(/\s/g, '').length
  const baseId = answer.questionId.replace(/-followup(?:-\d+)?$/, '')
  const question = questions?.find(item => item.id === baseId) ?? getQuestionById(answer.questionId)
  const keywordGroups = question?.keywords ?? []
  const matchedKeywords = keywordGroups.filter(group => matchesKeyword(text, group))
  const missingKeywords = keywordGroups.filter((group) => !matchedKeywords.includes(group))
  const completenessScore = characters === 0 ? 0 : clamp(characters / 140 * 100)
  const keywordScore = keywordGroups.length === 0
    ? (characters ? 50 : 0)
    : clamp(matchedKeywords.length / keywordGroups.length * 100)

  const hasSequence = /首先|其次|然后|最后|第一|第二|一是|二是|先.{0,6}再|first|second/i.test(text)
  const hasExample = /例如|比如|举例|曾经|当时|项目中|案例|具体|结果|提升|下降|%|数据|指标|for example/i.test(text)
  const sentences = text.split(/[。！？!?;；\n]+/).map((part) => part.trim()).filter(Boolean).length
  const structureScore = characters === 0 ? 0 : clamp(
    (characters >= 30 ? 30 : characters / 30 * 30) +
    (sentences >= 2 ? 20 : 0) +
    (hasSequence ? 25 : 0) +
    (hasExample ? 25 : 0),
  )
  const score = clamp(completenessScore * 0.4 + keywordScore * 0.35 + structureScore * 0.25)

  const suggestions: string[] = []
  if (!text) {
    suggestions.push('本题尚未作答；下次先说结论，再补充一个具体例子。')
  } else {
    if (characters < 80) suggestions.push('补充背景、你的具体行动和实际结果，让回答更完整。')
    if (missingKeywords.length) {
      suggestions.push('可进一步说明：' + missingKeywords.slice(0, 2).map((group) => group.split('|')[0]).join('、') + '。')
    }
    if (structureScore < 65) suggestions.push('尝试按“背景—行动—结果”分段，并加入可验证的例子。')
    if (!suggestions.length) suggestions.push('内容已较完整；可以继续压缩开场，让重点更快出现。')
  }

  return {
    questionId: answer.questionId,
    prompt: answer.prompt,
    answer: text,
    completenessScore,
    keywordScore,
    structureScore,
    score,
    matchedKeywords: matchedKeywords.map((group) => group.split('|')[0]),
    missingKeywords: missingKeywords.map((group) => group.split('|')[0]),
    suggestions,
    explanation: '基于 ' + characters + ' 字回答、' + matchedKeywords.length + '/' + keywordGroups.length + ' 组主题词（完整词组或各组成词均出现），以及分段/顺序词/案例提示计算。',
  }
}

/** Physiological readings are deliberately excluded from all answer scores. */
export function generateInterviewReport(record: Omit<InterviewRecord, 'report'>): InterviewReport {
  const questionFeedback = record.answers.map(answer => evaluate(answer, record.questions))
  const completenessScore = average(questionFeedback.map((item) => item.completenessScore))
  const keywordScore = average(questionFeedback.map((item) => item.keywordScore))
  const structureScore = average(questionFeedback.map((item) => item.structureScore))
  const overallScore = average(questionFeedback.map((item) => item.score))
  const strengths: string[] = []
  const improvements: string[] = []

  const completedAnswers = record.answers.filter((item) => item.answer.trim().length > 0).length
  if (completedAnswers) {
    if (completenessScore >= 70) strengths.push('多数回答展开充分，提供了较完整的信息。')
    if (keywordScore >= 65) strengths.push('回答覆盖了较多与题目相关的主题。')
    if (structureScore >= 65) strengths.push('回答具有一定结构，并使用例子或结果支撑观点。')
    if (!strengths.length) strengths.push('已提交 ' + completedAnswers + ' 次回答，留下了可复盘的具体内容。')
  } else {
    strengths.push('本次尚无作答，可从一道熟悉的问题开始练习。')
  }

  if (completenessScore < 70) improvements.push('回答可进一步展开背景、行动与结果。')
  if (keywordScore < 65) improvements.push('可更直接地回应题目中的核心主题。')
  if (structureScore < 65) improvements.push('回答结构可以更清晰，增加顺序词和具体例子。')
  if (!improvements.length) improvements.push('继续提高表达的精炼度与量化证据。')

  const nextSteps = questionFeedback.length
    ? questionFeedback
        .slice()
        .sort((a, b) => a.score - b.score)
        .slice(0, 2)
        .map((item) => '重练“' + item.prompt.replace(/\s+请.+$/, '').slice(0, 24) + '”：“' + item.suggestions[0] + '”')
    : ['选择一个熟悉的话题，练习用背景、行动、结果完成一次回答。']

  return {
    overallScore,
    completenessScore,
    keywordScore,
    structureScore,
    questionFeedback,
    strengths,
    improvements,
    nextSteps,
    scoringMethod: '本地规则评分：完整度 40%（非空字数，上限 140 字）；主题词覆盖 35%（'
      + (record.questions?.some(question => question.id.startsWith('ai-')) ? 'DeepSeek 生成题目的主题词组' : '题库关键词组')
      + '）；结构 25%（回答长度、句子数、顺序词与案例提示）。仅评估回答文本，生理数据不参与评分。',
  }
}
