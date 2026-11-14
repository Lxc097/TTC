import { QUESTION_BANK } from '../data/questions'
import { DIFFICULTY_PROFILES } from '../data/difficultyProfiles'
import type { InterviewConfig, InterviewQuestion, InterviewType } from '../types/interview'

const TYPE_ORDER: InterviewType[] = ['general', 'technical', 'behavioral', 'pressure']

function makeQuestion(config: InterviewConfig, type: InterviewType, index: number): InterviewQuestion {
  const seed = QUESTION_BANK[config.role][type][index]
  return {
    id: config.role + '-' + type + '-' + (index + 1),
    role: config.role,
    type,
    difficulty: config.difficulty,
    prompt: seed.prompt + ' ' + DIFFICULTY_PROFILES[config.difficulty].questionInstruction,
    keywords: seed.keywords,
    followUps: seed.followUps,
  }
}

/** Duration controls the question count. Type controls the first three questions;
 * role controls the entire bank; difficulty changes instructions and follow-ups. */
export function createQuestionPlan(config: InterviewConfig): InterviewQuestion[] {
  const count = config.durationMinutes === 5 ? 3 : config.durationMinutes === 10 ? 5 : 7
  const primary = QUESTION_BANK[config.role][config.type].map((_, index) => makeQuestion(config, config.type, index))
  const supplementaryTypes = TYPE_ORDER.filter((type) => type !== config.type)
  const supplementary: InterviewQuestion[] = []

  // Round robin gives a 15-minute session a wider range without losing the
  // requested type as its dominant opening section.
  for (let index = 0; index < 3; index += 1) {
    for (const type of supplementaryTypes) {
      supplementary.push(makeQuestion(config, type, index))
    }
  }

  return [...primary, ...supplementary].slice(0, count)
}

export function getQuestionById(id: string): InterviewQuestion | null {
  const baseId = id.replace(/-followup(?:-\d+)?$/, '')
  const match = /^(frontend|backend|product|marketing|general)-(general|technical|behavioral|pressure)-([1-3])$/.exec(baseId)
  if (!match) return null
  const role = match[1] as InterviewConfig['role']
  const type = match[2] as InterviewType
  const index = Number(match[3]) - 1
  const seed = QUESTION_BANK[role][type][index]
  return { id: baseId, role, type, difficulty: 'standard', prompt: seed.prompt, keywords: seed.keywords, followUps: seed.followUps }
}

/** Local, explainable fallback. The fourth argument is zero-based follow-up count. */
export function pickFollowUp(answer: string, question: InterviewQuestion, config: InterviewConfig, followUpCount = 0): string | null {
  const trimmed = answer.trim()
  const profile = DIFFICULTY_PROFILES[config.difficulty]
  if (!trimmed || followUpCount >= profile.maxFollowUps) return null
  const missing = question.keywords.filter((group) =>
    !group.split('|').some((word) => trimmed.toLocaleLowerCase().includes(word.toLocaleLowerCase())),
  )
  if (config.difficulty === 'basic') {
    if (trimmed.length >= 90 && missing.length === 0) return null
    return trimmed.length < 45
      ? '谢谢你的回答。能结合一个具体经历或案例再展开一点吗？'
      : (question.followUps[0] ?? '你能再举一个具体例子吗？')
  }
  if (followUpCount === 0) {
    if (trimmed.length < 45) return '能结合一个具体经历，说明你采取了什么行动以及结果吗？'
    if (config.difficulty === 'challenge' || missing.length > 0 || trimmed.length < 120) {
      return question.followUps[0] ?? '你如何验证这个方案取得了预期结果？'
    }
    return null
  }
  if (config.difficulty === 'challenge') {
    return '如果时间和资源都进一步收紧，你会按什么顺序行动？请说明取舍理由和验证证据。'
  }
  if (missing.length >= 1 || trimmed.length < 100) {
    return '这项选择可能有什么风险？你会用什么具体指标确认结果？'
  }
  return null
}
