import type { InterviewTranscriptEvent } from '../types/interview'

/** Browser interim results are mutable UI state; only stable final segments enter history. */
export function upsertFinalSegment(events: readonly InterviewTranscriptEvent[], next: InterviewTranscriptEvent): InterviewTranscriptEvent[] {
  if (!next.isFinal || next.source !== 'voice') return [...events]
  const index = next.segmentId ? events.findIndex(event => event.source === 'voice' && event.segmentId === next.segmentId) : -1
  if (index < 0) return [...events, next]
  if (events[index].rawText === next.rawText) return [...events]
  const updated = [...events]
  updated[index] = next
  return updated
}

function appendWithoutOverlap(previous: string, incoming: string): string {
  if (!previous) return incoming
  if (!incoming || previous.endsWith(incoming)) return previous
  const longest = Math.min(previous.length, incoming.length)
  for (let length = longest; length >= 2; length -= 1) {
    if (previous.slice(-length) === incoming.slice(0, length)) return previous + incoming.slice(length)
  }
  return previous + ' ' + incoming
}

export function joinFinalTranscript(events: readonly InterviewTranscriptEvent[]): string {
  return events.filter(event => event.source === 'voice' && event.isFinal)
    .reduce((answer, event) => appendWithoutOverlap(answer, event.correctedText.trim()), '')
}

export function appendConfirmedTranscript(answer: string, pending: string): string {
  return appendWithoutOverlap(answer.trim(), pending.trim())
}
