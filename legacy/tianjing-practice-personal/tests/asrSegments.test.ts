import assert from 'node:assert/strict'
import test from 'node:test'
import { appendConfirmedTranscript, joinFinalTranscript, upsertFinalSegment } from '../src/utils/asrSegments'
import type { InterviewTranscriptEvent } from '../src/types/interview'

function segment(id: string, text: string): InterviewTranscriptEvent {
  return { segmentId: id, timestamp: '2026-11-14T00:00:00Z', rawText: text, correctedText: text, isFinal: true, source: 'voice' }
}

test('interim growth never enters history and a repeated final segment replaces instead of appending', () => {
  let history: InterviewTranscriptEvent[] = []
  for (const text of ['我', '我是', '我是好', '我是好孩子']) {
    history = upsertFinalSegment(history, { ...segment('1:0', text), isFinal: false })
  }
  assert.equal(history.length, 0)
  history = upsertFinalSegment(history, segment('1:0', '我是好孩子'))
  history = upsertFinalSegment(history, segment('1:0', '我是好孩子'))
  assert.equal(history.length, 1)
  assert.equal(joinFinalTranscript(history), '我是好孩子')
})

test('multiple confirmed sentences survive and overlapping suffixes are not repeated', () => {
  const events = [segment('1:0', '我负责接口设计。'), segment('1:1', '通过压测验证效果。')]
  assert.equal(joinFinalTranscript(events), '我负责接口设计。 通过压测验证效果。')
  assert.equal(appendConfirmedTranscript('我是好孩子', '好孩子今天很开心'), '我是好孩子今天很开心')
})
