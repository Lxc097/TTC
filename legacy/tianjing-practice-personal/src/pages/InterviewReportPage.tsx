import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowRight, CheckCircle2, Clock3, FileText, Info, RotateCcw, TrendingUp } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { getInterviewRecord } from '../utils/storage'
import { DIFFICULTY_LABELS, ROLE_LABELS, TYPE_LABELS, type BiometricSample, type FacePhysRawBatch, type InterviewAnswer, type InterviewRecord, type InterviewTranscriptEvent } from '../types/interview'
import './report.css'

function minutes(seconds: number) { const m = Math.floor(seconds / 60), s = seconds % 60; return m + '分' + String(s).padStart(2, '0') + '秒' }
function ScoreBar({ label, value }: { label: string; value: number }) { return <div className="score-bar-row"><div><span>{label}</span><b>{value}</b></div><div className="score-bar"><span style={{ width: value + '%' }} /></div></div> }
function analysisStatus(record: InterviewRecord): 'pending' | 'complete' | 'failed' | undefined {
  const status = record.biometrics?.status
  return status === 'pending' && Date.now() - Date.parse(record.endedAt) > 3 * 60 * 1000 ? 'failed' : status
}
function analysisError(record: InterviewRecord): string | undefined {
  return record.biometrics?.status === 'pending' && analysisStatus(record) === 'failed'
    ? '本次后台分析已超时或页面曾关闭；不会补造生理结果。' : record.biometrics?.error
}
function realSamples(record: InterviewRecord): BiometricSample[] {
  if (record.biometrics?.mode !== 'api') return []
  return record.biometrics.samples.filter(sample => sample.reaction?.source !== 'mock')
}
function rawBatches(record: InterviewRecord): FacePhysRawBatch[] {
  if (record.biometrics?.mode !== 'api') return []
  return record.biometrics.rawBatches || []
}
function displayTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未提供' : date.toLocaleString('zh-CN')
}
function validHeartRate(sample: BiometricSample): boolean {
  return typeof sample.heartRateBpm === 'number' && Number.isFinite(sample.heartRateBpm)
    && sample.heartRateBpm >= 40 && sample.heartRateBpm <= 180
    && (sample.signalQuality === 'good' || sample.signalQuality === 'fair')
}
function samplesForAnswer(samples: BiometricSample[], answer: InterviewAnswer): BiometricSample[] {
  const baseId = answer.questionId.replace(/-followup(?:-\d+)?$/, '')
  const followUp = answer.questionId.match(/-followup-(\d+)$/)
  const suffix = ':' + (followUp ? followUp[1] : '0')
  return samples.filter(sample => sample.roundKey && answer.roundKey
    ? sample.roundKey === answer.roundKey
    : (sample.questionId === baseId || sample.questionId === answer.questionId)
      && (!sample.roundKey || sample.roundKey.endsWith(suffix)))
}
function confirmedEvents(events: InterviewTranscriptEvent[]): InterviewTranscriptEvent[] {
  return events.filter(event => event.isFinal || event.source === 'text')
}
function TranscriptEvidence({ events }: { events: InterviewTranscriptEvent[] }) {
  const finalEvents = confirmedEvents(events)
  if (!finalEvents.length) return <p className="report-details-note">旧记录只有临时字幕；以上方最终回答为准，不把中间识别变化当作独立作答。</p>
  return <div className="report-event-list">
    {events.length > finalEvents.length && <p className="report-details-note">已折叠 {events.length - finalEvents.length} 条临时字幕；原记录未被修改。</p>}
    {finalEvents.map((event, index) => <div className="report-event" key={event.timestamp + '-' + index}>
      <time>{new Date(event.timestamp).toLocaleTimeString('zh-CN')}</time>
      <span>{event.source === 'voice' ? '语音确认' : '人工编辑'}</span>
      <p>{event.rawText}</p>
      {event.correctedText !== event.rawText && <small>确认文本：{event.correctedText}</small>}
    </div>)}
  </div>
}
function BiometricEvidence({ samples }: { samples: BiometricSample[] }) {
  return <div className="report-bio-list">
    <p>以下为 FacePhys 返回的分段采样，时间关联不等于情绪或能力判断。</p>
    {samples.map((sample, index) => <div className="report-bio-row" key={sample.timestamp + '-' + index}>
      <time>{new Date(sample.timestamp).toLocaleTimeString('zh-CN')}</time>
      <span>{validHeartRate(sample) ? Math.round(sample.heartRateBpm as number) + ' BPM' : '心率不可用'}</span>
      <span>信号：{sample.signalQuality === 'good' ? '良好' : sample.signalQuality === 'fair' ? '偏弱，仅供参考' : '不足'}</span>
      {sample.reaction?.source === 'facephys' && <span>{sample.reaction.label}</span>}
    </div>)}
  </div>
}
function AnswerCard({ answer, index, record, samples }: { answer: InterviewAnswer; index: number; record: InterviewRecord; samples: BiometricSample[] }) {
  const feedback = record.report.questionFeedback?.[index]
  const related = samplesForAnswer(samples, answer)
  const events = answer.transcriptEvents || []
  const finalCount = confirmedEvents(events).length
  return <article className="answer-card" key={index}>
    <div className="answer-number">{String(index + 1).padStart(2, '0')}</div>
    <div className="answer-content">
      <div className="answer-meta"><span><Clock3 size={14} />{minutes(answer.durationSeconds)} · {new Date(answer.answeredAt).toLocaleTimeString('zh-CN')}</span><span>{answer.inputMode === 'voice' ? '语音转文字' : '文字输入'}</span>{answer.isFollowUp && <span>动态追问</span>}<b>{feedback?.score ?? 0} 分</b></div>
      <h3>{answer.prompt}</h3>
      <div className="report-final-answer"><span>最终回答</span><p>{answer.answer || '未作答，已跳过此题。'}</p></div>
      <div className="report-answer-analysis"><div className="report-analysis-title"><strong>回答内容分析</strong><span>{answer.aiSummarySource === 'deepseek' ? 'DeepSeek' : '本地可解释规则'}</span></div>
        <p>{answer.aiSummary || feedback?.explanation || '本题没有可评价的回答。'}</p>
        {feedback?.matchedKeywords?.length > 0 && <small>已覆盖：{feedback.matchedKeywords.join('、')}</small>}
        {feedback?.suggestions?.length > 0 && <ul>{feedback.suggestions.map((tip, tipIndex) => <li key={tipIndex}>{tip}</li>)}</ul>}
      </div>
      {related.length > 0 && <details className="report-details"><summary>多模态观察 · {related.length} 条真实采样</summary><BiometricEvidence samples={related} /></details>}
      {events.length > 0 && <details className="report-details"><summary>查看详细事件 · {finalCount} 条确认文本</summary><TranscriptEvidence events={events} /></details>}
    </div>
  </article>
}
function SignalSection({ record, samples }: { record: InterviewRecord; samples: BiometricSample[] }) {
  const status = analysisStatus(record)
  const chartData = samples.filter(validHeartRate).map(sample => ({
    time: new Date(sample.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    bpm: sample.heartRateBpm,
  }))
  let title = '未启用画面分析'
  let detail = '本次面试没有授权 FacePhys 上传视频；纯内容报告仍可完整查看。'
  if (record.biometrics?.mode === 'mock') {
    title = '历史演示记录'
    detail = '该旧记录使用过模拟生理数据。为避免误读，模拟数值和图表已从正式报告中隐藏。'
  } else if (record.biometrics?.mode === 'api') {
    if (status === 'pending') { title = 'FacePhys 正在分析'; detail = '文本报告已生成，真实视频分段结果返回后会自动更新此页。' }
    else if (status === 'failed') { title = 'FacePhys 分析未完成'; detail = analysisError(record) || '未获得可用结果；文本报告不受影响。' }
    else if (samples.length) { title = 'FacePhys 真实分段结果'; detail = '仅展示 API 返回的有效采样。生理变化不参与文本评分，也不代表人格、心理或健康诊断。' }
    else { title = 'FacePhys 暂无有效采样'; detail = '本次未获得可展示的真实数据，因此不生成图表或状态结论。' }
  }
  return <section className="report-section"><div className="report-section-heading"><div><span className="section-kicker">独立观察</span><h2>多模态分析</h2></div></div>
    <div className="report-signal-summary" aria-live="polite"><FileText size={21} /><div><h3>{title}</h3><p>{detail}</p>{samples.length > 0 && <small>{samples.length} 条返回采样 · {chartData.length} 条有效心率</small>}</div></div>
    {chartData.length > 1 && <div className="report-signal-chart"><ResponsiveContainer width="100%" height={180}><LineChart data={chartData}><CartesianGrid strokeDasharray="3 4" stroke="#ececec" /><XAxis dataKey="time" tick={{ fontSize: 10, fill: '#87827b' }} tickLine={false} axisLine={false} /><YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: '#87827b' }} tickLine={false} axisLine={false} /><Tooltip formatter={value => [String(value) + ' BPM', '估计心率']} /><Line type="monotone" dataKey="bpm" stroke="#ff5c00" strokeWidth={2.5} dot={false} /></LineChart></ResponsiveContainer></div>}
    {record.report.multimodalSummary && <p className="report-multimodal-summary"><strong>多模态复盘 · 真实采样与回答内容</strong>{record.report.multimodalSummary}</p>}
  </section>
}
function FacePhysRawSection({ record }: { record: InterviewRecord }) {
  const batches = rawBatches(record)
  const status = analysisStatus(record)
  const enabled = record.biometrics?.mode === 'api'
  const stateText = !enabled ? (record.biometrics?.mode === 'mock' ? '历史演示记录，无真实 API 原始数据' : '未授权或未启用')
    : status === 'pending' ? '等待 FacePhys 返回'
      : status === 'failed' ? '分析失败'
        : batches.length ? '已收到真实 API 数据' : '暂无保留的原始数据'
  return <section className="report-section report-raw-section" aria-label="FacePhys 原始分析">
    <div className="report-section-heading"><div><span className="section-kicker">数据依据</span><h2>FacePhys 原始分析</h2></div><span>{batches.length} 段</span></div>
    <div className="report-raw-frame" aria-live="polite">
      <div className="report-raw-status"><span>来源：{enabled ? 'FacePhys API · 服务端脱敏' : '未取得真实 API 数据'}</span><strong>{stateText}</strong></div>
      {!batches.length && <p className="report-raw-empty">{status === 'failed' ? (analysisError(record) || 'FacePhys 未返回可用分析结果。')
        : status === 'pending' ? '视频分段仍在处理中；本页会自动更新，纯内容报告可正常查看。'
          : enabled ? '该记录未包含可核对的 API 原始响应；不会补造结果。'
            : '本次没有真实 FacePhys 分析结果。'}</p>}
      {batches.map((batch, index) => <div className="report-raw-batch" key={batch.receivedAt + '-' + index}>
        <div className="report-raw-batch-title"><strong>分析片段 {String(index + 1).padStart(2, '0')}</strong><span>FacePhys · API 返回</span></div>
        <dl><div><dt>采集时间</dt><dd>{displayTime(batch.capturedAt)}</dd></div><div><dt>结果接收</dt><dd>{displayTime(batch.receivedAt)}</dd></div>
          <div><dt>视频时长</dt><dd>{typeof batch.videoDurationSeconds === 'number' && Number.isFinite(batch.videoDurationSeconds) ? batch.videoDurationSeconds + ' 秒' : 'API 未提供'}</dd></div></dl>
        <details className="report-raw-json"><summary>查看服务端脱敏后的 API data JSON</summary><pre>{JSON.stringify(batch.rawData, null, 2)}</pre></details>
      </div>)}
    </div>
  </section>
}
function ReportContent({ record }: { record: InterviewRecord }) {
  const report = record.report
  const samples = realSamples(record)
  const completed = record.answers.filter(answer => answer.answer.trim() && !answer.isFollowUp).length
  const targetRole = (record.config as typeof record.config & { targetRole?: string }).targetRole?.trim()
    || record.config.targetRoleDescription?.trim() || ROLE_LABELS[record.config.role]
  return <div className="container page-spacing report-page">
    <div className="report-top"><div><span className="section-kicker">本次面试已完成</span><h1>面试分析报告</h1><p>依据最终回答复盘，生理信号单独呈现。</p></div><div className="report-top-actions"><Link className="button button-secondary" to="/history">全部记录</Link><Link className="button button-primary" to="/setup">再次练习 <ArrowRight size={17} /></Link></div></div>
    <div className="report-overview"><div className="report-score"><div className="score-ring" style={{ background: 'conic-gradient(#ff5c00 ' + report.overallScore + '%, #fff2eb 0)' }}><div><strong>{report.overallScore}</strong><span>文本评分</span></div></div><div><h2>回答表现概览</h2><p>无效回答不会得到无依据的能力判断。逐题查看实际回答与改进依据。</p></div></div><div className="report-facts"><div><span>目标岗位</span><b>{targetRole}</b></div><div><span>面试类型</span><b>{TYPE_LABELS[record.config.type]}</b></div><div><span>难度</span><b>{DIFFICULTY_LABELS[record.config.difficulty]}</b></div><div><span>实际时长</span><b>{minutes(record.elapsedSeconds)}</b></div><div><span>完成题数</span><b>{completed} / {record.questions?.length || (record.config.durationMinutes === 5 ? 3 : record.config.durationMinutes === 10 ? 5 : 7)}</b></div></div></div>
    <div className="report-grid"><section className="report-card"><div className="card-title"><TrendingUp size={19} /><h2>回答维度</h2></div><ScoreBar label="回答完整度" value={report.completenessScore} /><ScoreBar label="关键词覆盖" value={report.keywordScore} /><ScoreBar label="表达结构" value={report.structureScore} /><p className="method-note"><Info size={16} />{report.scoringMethod}</p></section><section className="report-card"><div className="card-title"><CheckCircle2 size={19} /><h2>综合复盘</h2></div><div className="recap-group"><h3>本次有证据的表现</h3>{report.strengths.map((item, i) => <p key={i}>{item}</p>)}</div><div className="recap-group"><h3>优先改进</h3>{report.improvements.map((item, i) => <p key={i}>{item}</p>)}</div><div className="recap-group"><h3>下一次练习</h3>{report.nextSteps.map((item, i) => <p key={i}>{item}</p>)}</div></section></div>
    <section className="report-section"><div className="report-section-heading"><div><span className="section-kicker">逐题回看</span><h2>问题与回答时间轴</h2></div><span>{record.answers.length} 条回答记录</span></div><div className="answer-timeline">{record.answers.length === 0 ? <div className="empty-inline">本次没有提交回答。下次可以从一道熟悉的题目开始。</div> : record.answers.map((answer, index) => <AnswerCard answer={answer} index={index} record={record} samples={samples} key={answer.roundKey || index} />)}</div></section>
    <SignalSection record={record} samples={samples} />
    <FacePhysRawSection record={record} />
    <div className="report-bottom"><span>报告保存在当前浏览器；原始视频未保存。</span><Link to="/setup" className="text-link"><RotateCcw size={16} />开始下一场面试</Link></div>
  </div>
}
export function InterviewReportPage() {
  const { id = '' } = useParams()
  const [record, setRecord] = useState<InterviewRecord | null>(() => getInterviewRecord(id) ?? null)
  useEffect(() => { setRecord(getInterviewRecord(id) ?? null) }, [id])
  useEffect(() => {
    const refresh = () => setRecord(getInterviewRecord(id) ?? null)
    window.addEventListener('interview-record-updated', refresh)
    return () => window.removeEventListener('interview-record-updated', refresh)
  }, [id])
  const pending = record ? analysisStatus(record) === 'pending' : false
  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => setRecord(getInterviewRecord(id) ?? null), 2000)
    return () => window.clearInterval(timer)
  }, [id, pending])
  if (!record) return <div className="container page-spacing empty-state"><div className="empty-icon"><FileText size={28} /></div><h1>找不到这份报告</h1><p>记录可能已删除，或保存在其他浏览器中。</p><Link className="button button-primary" to="/history">返回面试记录</Link></div>
  return <ReportContent record={record} />
}
