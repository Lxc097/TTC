import type { InterviewDifficulty } from '../types/interview'

export interface DifficultyProfile {
  label: string
  maxFollowUps: number
  questionInstruction: string
  followUpInstruction: string
  interviewerStyle: string
}

/** One consistent interviewer identity; difficulty changes depth and tone only. */
export const DIFFICULTY_PROFILES: Record<InterviewDifficulty, DifficultyProfile> = {
  basic: {
    label: '基础',
    maxFollowUps: 1,
    questionInstruction: '请用一个简明例子说明；如题意不清，可以先解释你的理解。',
    followUpInstruction: '用温和、清晰的短句追问；必要时解释题意，只追问一个可展开的具体例子。',
    interviewerStyle: '你是同一位专业、尊重面试者的 AI 面试官。语气温和清晰，允许解释题意；不要使用侮辱、攻击或心理诊断语言。',
  },
  standard: {
    label: '标准',
    maxFollowUps: 2,
    questionInstruction: '请说明你的思路、具体行动与验证方式。',
    followUpInstruction: '保持专业客观，围绕目标岗位能力和真实实践追问，聚焦回答中尚未说明的一个关键点。',
    interviewerStyle: '你是同一位专业、尊重面试者的 AI 面试官。语气专业客观，围绕岗位能力和实际经历提问；不要使用侮辱、攻击或心理诊断语言。',
  },
  challenge: {
    label: '挑战',
    maxFollowUps: 2,
    questionInstruction: '请说明复杂约束下的行动顺序、关键取舍、理由、风险与可验证的证据。',
    followUpInstruction: '引入一个合理的新约束，要求说明行动顺序、决策取舍、理由和验证证据。保持尊重，绝不使用侮辱或攻击性语言。',
    interviewerStyle: '你是同一位专业、尊重面试者的 AI 面试官。提问深入，聚焦复杂约束、决策取舍和证据；保持克制与尊重，不使用侮辱、攻击或心理诊断语言。',
  },
}
