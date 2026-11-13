import type { BiometricReading } from '../services/biometrics'
import type { QuestionReaction } from '../types/interview'

/**
 * Turns a FacePhys/mock reading into a cautious, non-diagnostic interview cue.
 * It deliberately avoids interpreting the provider's emotion field as a
 * hiring judgement. The cue is only a prompt for the candidate's own review.
 */
export function describeQuestionReaction(reading: BiometricReading | null): QuestionReaction {
  if (!reading) {
    return {
      label: '暂无生理信号',
      detail: 'FacePhys 需要一段完整视频后才会返回结果；本题暂未获得可用采样。',
      source: 'unavailable',
    }
  }

  const bpm = typeof reading.heartRateBpm === 'number' ? Math.round(reading.heartRateBpm) : undefined
  const source = reading.source === 'api' ? 'facephys' : 'mock'
  if (reading.signalQuality === 'unavailable' || bpm === undefined) {
    return {
      label: '信号不足',
      detail: source === 'facephys' ? 'FacePhys 本段信号质量不足，无法形成可靠的状态提示。' : '演示数据暂未生成有效心率。',
      source,
      signalQuality: reading.signalQuality,
    }
  }

  const label = bpm >= 100 ? '偏紧张倾向' : bpm >= 86 ? '轻微紧张倾向' : '状态较稳定'
  const detail = source === 'facephys'
    ? `本段估计心率 ${bpm} BPM，信号质量${reading.signalQuality === 'good' ? '良好' : reading.signalQuality === 'fair' ? '一般' : '偏低'}；这只是生理变化提示，不能等同于情绪或能力判断。`
    : `演示心率 ${bpm} BPM；当前为模拟数据，与摄像头真实检测无关。`

  return { label, detail, source, heartRateBpm: bpm, signalQuality: reading.signalQuality }
}

/** Transparent local fallback used only when DeepSeek is unavailable. */
export function localAnswerSummary(answer: string): string {
  const text = answer.trim()
  const length = text.replace(/\s/g, '').length
  if (!length) return '本题没有有效回答，暂时无法判断对该类问题的熟悉程度。'
  const hasEvidence = /例如|比如|项目|结果|指标|提升|下降|数据|负责|实现|复盘|因为|所以/.test(text)
  if (length >= 80 && hasEvidence) return '回答包含较完整的背景、行动或结果信息，显示出对这类问题有一定准备。'
  if (length >= 40) return '回答覆盖了部分要点，但具体行动或结果证据还可以继续补充。'
  return '回答较短，现有内容不足以判断对这类问题的熟悉程度，建议补充具体例子。'
}
