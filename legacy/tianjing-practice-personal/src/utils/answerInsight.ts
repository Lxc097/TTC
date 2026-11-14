import type { BiometricReading } from '../services/biometrics'
import type { QuestionReaction } from '../types/interview'

/**
 * Turns a FacePhys/mock reading into a cautious, non-diagnostic interview cue.
 * It deliberately avoids interpreting the provider's emotion field as a
 * hiring judgement. The cue is only a prompt for the candidate's own review.
 */
export function describeQuestionReaction(reading: BiometricReading | null, previousReadings: readonly BiometricReading[] = []): QuestionReaction {
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

  if (source === 'mock') return {
    label: '演示状态变化',
    detail: `演示心率 ${bpm} BPM；当前为模拟数据，与摄像头真实检测无关。`,
    source, heartRateBpm: bpm, signalQuality: reading.signalQuality,
  }
  if (reading.signalQuality === 'poor') return {
    label: '信号质量偏低',
    detail: `本段估计心率 ${bpm} BPM，但信号质量偏低，不据此推断紧张或自信。`,
    source, heartRateBpm: bpm, signalQuality: reading.signalQuality,
  }
  const reference = previousReadings
    .filter(item => item.source === 'api' && (item.signalQuality === 'good' || item.signalQuality === 'fair')
      && typeof item.heartRateBpm === 'number' && Number.isFinite(item.heartRateBpm))
    .slice(0, 5)
    .map(item => item.heartRateBpm as number)
  if (reference.length < 2) return {
    label: '个人参考值建立中',
    detail: `本段估计心率 ${bpm} BPM；需要更多本人有效采样，不能仅凭绝对心率判断紧张或自信。`,
    source, heartRateBpm: bpm, signalQuality: reading.signalQuality,
  }
  const baseline = reference.reduce((sum, value) => sum + value, 0) / reference.length
  const delta = bpm - baseline
  const label = delta >= 8 ? '相对参考值升高' : delta <= -8 ? '相对参考值降低' : '相对参考值平稳'
  const detail = `本段估计心率 ${bpm} BPM，相比本次前期有效采样均值 ${Math.round(baseline)} BPM ${delta >= 0 ? '高' : '低'}约 ${Math.round(Math.abs(delta))} BPM。${reading.signalQuality === 'fair' ? '信号偏弱，仅供参考。' : ''}心率变化可能受多种因素影响，不能单独判定紧张、自信或回答能力。`
  return { label, detail, source, heartRateBpm: bpm, signalQuality: reading.signalQuality }
}

/** Transparent local fallback used only when DeepSeek is unavailable. */
export function localAnswerSummary(answer: string): string {
  const text = answer.trim()
  const length = text.replace(/\s/g, '').length
  if (!length) return '本题没有回答，无法判断相关能力表现。'
  if (length < 8 || !/[\p{L}]/u.test(text)) return '本次回答未包含可用于评价该问题的信息，无法判断相关能力表现；请围绕题目重新作答。'
  const excerpt = text.replace(/\s+/g, ' ').slice(0, 36) + (text.length > 36 ? '…' : '')
  const hasAction = /负责|设计|实现|排查|分析|推动|协调|测试|验证|采用|选择|解决|我做|我会/.test(text)
  const hasVerification = /验证|测试|日志|监控|实验|复盘/.test(text)
  const hasResult = /结果|上线|改善|提升|下降|减少|增加|达到|完成了|实现了|\d+(?:\.\d+)?\s*(?:%|倍|毫秒|秒|次|人|元)/.test(text)
  if (length < 40 && hasAction) return '你已说明“' + excerpt + '”中的具体行动' + (hasVerification ? '和验证步骤' : '') + '；请进一步解释它们与题目要求的关系，并补充实际结果（如有）。'
  if (length < 40) return '你回答了“' + excerpt + '”，但尚未说明具体行动或可核实的证据；请围绕题目补充。'
  if (hasAction && hasResult) return '回答中的“' + excerpt + '”包含行动与结果线索；可继续交代选择依据、本人负责的范围' + (hasVerification ? '。' : '，以及结果如何验证。')
  if (hasAction) return '回答中的“' + excerpt + '”描述了行动' + (hasVerification ? '和验证步骤' : '') + '，但尚未给出实际测得的结果；请补充真实可核查的证据。'
  return '回答中的“' + excerpt + '”提供了内容，但尚未说明你具体做了什么、为何这样做，以及结果如何验证。'
}
