import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, CalendarDays, Clock3, FileText, RotateCcw, Trash2 } from 'lucide-react'
import { deleteInterviewRecord, getInterviewRecords } from '../utils/storage'
import { ROLE_LABELS, TYPE_LABELS, type InterviewRecord } from '../types/interview'

export function InterviewHistory() {
  const navigate = useNavigate()
  const [records,setRecords] = useState(() => getInterviewRecords())
  function restart(record:InterviewRecord) { sessionStorage.setItem('yingda.draft',JSON.stringify(record.config)); navigate('/setup') }
  function remove(record:InterviewRecord) { if (!window.confirm('确定删除这条面试记录吗？此操作无法撤销。')) return; deleteInterviewRecord(record.id); setRecords(getInterviewRecords()) }
  return <div className="container page-spacing"><div className="history-header"><div><span className="section-kicker">我的练习</span><h1>面试记录</h1><p>回看每一次回答，找到清晰可执行的下一步。</p></div><Link className="button button-primary" to="/setup">开始新面试 <ArrowRight size={18} /></Link></div>
  {records.length===0 ? <div className="empty-state"><div className="empty-icon"><FileText size={28}/></div><h2>还没有面试记录</h2><p>完成一次模拟面试后，报告会自动保存在这台浏览器中。</p><Link className="button button-primary" to="/setup">开始第一次练习</Link></div> : <div className="history-list">{records.map(record => <article className="history-item" key={record.id}><div className="history-item-icon"><FileText size={22}/></div><div className="history-item-body"><h2>{record.config.targetRoleDescription?.trim() || ROLE_LABELS[record.config.role]} <span>· {TYPE_LABELS[record.config.type]}</span></h2><div className="history-meta"><span><CalendarDays size={14}/>{new Date(record.startedAt).toLocaleString('zh-CN')}</span><span><Clock3 size={14}/>{Math.ceil(record.elapsedSeconds/60)} 分钟</span><span>{record.answers.filter(a => a.answer.trim() && !a.isFollowUp).length} 题已回答</span></div></div><div className="history-score"><strong>{record.report.overallScore}</strong><small>文本评分</small></div><div className="history-actions"><Link to={'/report/'+record.id} className="button button-light">查看报告</Link><button title="再次练习" aria-label="再次练习" onClick={() => restart(record)}><RotateCcw size={18}/></button><button title="删除记录" aria-label="删除记录" onClick={() => remove(record)}><Trash2 size={18}/></button></div></article>)}</div>}
  </div>
}
