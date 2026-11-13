export interface CorrectedTranscript {
  correctedText: string
  correctionNotes: string[]
}

/**
 * Applies only transparent, reversible cleanup to a transcript event. The
 * original browser text is always stored beside this value.
 */
export function correctTranscriptText(rawText: string): CorrectedTranscript {
  const collapsed = rawText.replace(/\s+/g, ' ').trim()
  const correctionNotes: string[] = []
  if (collapsed !== rawText) correctionNotes.push('合并多余空白')

  // Browser recognition can repeat one complete phrase in a single event.
  // Remove only an exact adjacent duplicate and keep the raw event unchanged.
  const duplicate = collapsed.match(/^(.{2,80}?)(?:\s*\1){1,}$/u)
  if (duplicate?.[1]) {
    correctionNotes.push('去除同一事件中的整段重复')
    return { correctedText: duplicate[1].trim(), correctionNotes }
  }
  return { correctedText: collapsed, correctionNotes }
}
