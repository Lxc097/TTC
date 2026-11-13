interface LiveTranscriptProps {
  draft: string
  interim: string
  onDraftChange: (text: string) => void
  onEditFocus?: () => void
  onEditBlur?: () => void
  manualEditing?: boolean
  pendingTranscript?: string
  onMergeTranscript?: () => void
}

/** Editable confirmed answer and provisional ASR captions are separate surfaces. */
export function LiveTranscript({ draft, interim, onDraftChange, onEditFocus, onEditBlur, manualEditing = false, pendingTranscript, onMergeTranscript }: LiveTranscriptProps) {
  return <section className="room-transcript">
    <div className="room-section-title">
      <div><h3>我的回答</h3><p>可直接修改转写，提交以此处文字为准</p></div>
      <span>{manualEditing ? '手动编辑中' : interim ? '正在转写' : '可编辑'}</span>
    </div>
    <label className="sr-only" htmlFor="room-answer-input">编辑本题回答</label>
    <textarea
      id="room-answer-input"
      className="room-transcript__editor"
      value={draft}
      onChange={event => onDraftChange(event.target.value)}
      onFocus={onEditFocus}
      onBlur={onEditBlur}
      placeholder="说出回答后，确认转写；也可以直接在这里输入、补充或修改。"
      spellCheck={false}
    />
    <div className="room-transcript__interim" aria-live="polite">
      <span>实时识别</span>
      <p>{interim || (manualEditing ? '手动编辑时，新的识别结果暂放在这里。' : '等待语音输入；文字回答始终可用。')}</p>
    </div>
    {pendingTranscript && <div className="room-transcript__pending"><p><strong>有新的已确认语音</strong>{pendingTranscript}</p><button type="button" onClick={onMergeTranscript}>合并到回答</button></div>}
  </section>
}
