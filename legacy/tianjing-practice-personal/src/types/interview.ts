export type InterviewRole = 'frontend' | 'backend' | 'product' | 'marketing' | 'general'
export type InterviewType = 'general' | 'technical' | 'behavioral' | 'pressure'
export type InterviewDifficulty = 'basic' | 'standard' | 'challenge'

export interface InterviewConfig {
  /** Free-form target position. Required for new interviews; legacy records may omit it. */
  targetRole: string
  role: InterviewRole
  type: InterviewType
  difficulty: InterviewDifficulty
  durationMinutes: 5 | 10 | 15
  /** Optional, user-written target role and interview context. */
  targetRoleDescription?: string
  /** Extracted resume text for AI question generation, kept only in session draft. */
  resumeText?: string
  resumeFileName?: string
}

export interface InterviewQuestion {
  id: string
  role: InterviewRole
  type: InterviewType
  difficulty: InterviewDifficulty
  prompt: string
  keywords: string[]
  followUps: string[]
}

export interface InterviewTranscriptEvent {
  /** Stable ASR segment identity; absent from legacy records. */
  segmentId?: string
  /** Final ASR segment or confirmed manual edit time. Interim text stays in UI memory. */
  timestamp: string
  rawText: string
  correctedText: string
  correctionNotes?: string[]
  isFinal: boolean
  source: 'voice' | 'text'
}

export interface InterviewAnswer {
  questionId: string
  /** Exact question/follow-up round, for linking delayed FacePhys samples. */
  roundKey?: string
  prompt: string
  answer: string
  startedAt: string
  answeredAt: string
  durationSeconds: number
  inputMode: 'text' | 'voice'
  isFollowUp?: boolean
  /** A non-diagnostic, per-question observation derived from the selected biometrics source. */
  reaction?: QuestionReaction
  /** A concise, evidence-based answer summary returned by DeepSeek or the local fallback. */
  aiSummary?: string
  aiSummarySource?: 'deepseek' | 'local'
  /** Complete raw transcript event stream for this question round. */
  transcriptEvents?: InterviewTranscriptEvent[]
}

export interface QuestionReaction {
  label: string
  detail: string
  source: 'facephys' | 'mock' | 'unavailable'
  heartRateBpm?: number
  signalQuality?: string
}

export interface BiometricSample {
  timestamp: string
  heartRateBpm?: number
  emotion?: string
  emotionConfidence?: number
  signalQuality?: string
  questionId?: string
  roundKey?: string
  reaction?: QuestionReaction
}

/** Server-redacted FacePhys API data for one completed video batch. Raw video is never stored. */
export interface FacePhysRawBatch {
  capturedAt: string
  receivedAt: string
  videoDurationSeconds?: number
  rawData: Record<string, unknown>
}

export interface QuestionFeedback {
  questionId: string
  prompt: string
  answer: string
  completenessScore: number
  keywordScore: number
  structureScore: number
  score: number
  matchedKeywords: string[]
  missingKeywords: string[]
  suggestions: string[]
  explanation: string
}

export interface InterviewReport {
  /** Local, evidence-limited synthesis of actual FacePhys samples and answer text. */
  multimodalSummary?: string
  overallScore: number
  completenessScore: number
  keywordScore: number
  structureScore: number
  questionFeedback: QuestionFeedback[]
  strengths: string[]
  improvements: string[]
  nextSteps: string[]
  scoringMethod: string
}

export interface InterviewRecord {
  id: string
  config: InterviewConfig
  /** Actual interview questions, including AI-generated keyword groups for explainable reports. */
  questions?: InterviewQuestion[]
  startedAt: string
  endedAt: string
  elapsedSeconds: number
  answers: InterviewAnswer[]
  report: InterviewReport
  biometrics?: {
    mode: 'mock' | 'api'
    samples: BiometricSample[]
    status?: 'pending' | 'complete' | 'failed'
    error?: string
    rawBatches?: FacePhysRawBatch[]
  }
}

export const ROLE_LABELS: Record<InterviewRole, string> = {
  frontend: '前端工程师',
  backend: '后端工程师',
  product: '产品经理',
  marketing: '市场运营',
  general: '综合能力面试',
}

export const TYPE_LABELS: Record<InterviewType, string> = {
  general: '综合面试',
  technical: '专业能力面试',
  behavioral: '行为面试',
  pressure: '压力面试',
}

export const DIFFICULTY_LABELS: Record<InterviewDifficulty, string> = {
  basic: '基础',
  standard: '标准',
  challenge: '挑战',
}

export const DEFAULT_INTERVIEW_CONFIG: InterviewConfig = {
  targetRole: '',
  role: 'frontend',
  type: 'general',
  difficulty: 'standard',
  durationMinutes: 10,
}
