import type { InterviewRecord } from '../types/interview'

const RECORDS_KEY = 'yingda.interview.records.v1'

export function getInterviewRecords(): InterviewRecord[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(RECORDS_KEY) || '[]')
    return Array.isArray(data) ? data.filter((item): item is InterviewRecord => Boolean(item && typeof item === 'object' && 'id' in item && 'report' in item)) : []
  } catch { return [] }
}

export function getInterviewRecord(id: string): InterviewRecord | undefined {
  const saved = getInterviewRecords().find(record => record.id === id)
  if (saved) return saved
  try {
    const fallback = JSON.parse(sessionStorage.getItem('yingda.unsaved-report') || 'null') as InterviewRecord | null
    return fallback?.id === id ? fallback : undefined
  } catch { return undefined }
}

export function saveInterviewRecord(record: InterviewRecord): void {
  const next = [record, ...getInterviewRecords().filter(item => item.id !== record.id)].slice(0, 100)
  localStorage.setItem(RECORDS_KEY, JSON.stringify(next))
}

export function deleteInterviewRecord(id: string): void {
  localStorage.setItem(RECORDS_KEY, JSON.stringify(getInterviewRecords().filter(item => item.id !== id)))
}
