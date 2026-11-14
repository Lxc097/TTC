import { useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle, ArrowLeft, ArrowRight, BriefcaseBusiness, CheckCircle2,
  Clock3, FileText, Gauge, LoaderCircle, MessageCircleMore, UploadCloud, X,
} from 'lucide-react'
import type { InterviewConfig } from '../types/interview'
import { clearFormalContext } from '../services/formalInterview'
import { MAX_RESUME_TEXT, parseResume } from '../utils/resume'

const roleOptions: { value: InterviewConfig['role']; label: string; description: string }[] = [
  { value: 'frontend', label: '前端工程师', description: '页面、性能与协作' },
  { value: 'backend', label: '后端工程师', description: '架构、数据与可靠性' },
  { value: 'product', label: '产品经理', description: '需求、判断与推动' },
  { value: 'marketing', label: '市场运营', description: '增长、内容与分析' },
  { value: 'general', label: '综合能力面试', description: '通用职场表达' },
]
const typeOptions: { value: InterviewConfig['type']; label: string; description: string }[] = [
  { value: 'general', label: '综合面试', description: '多维度考察' },
  { value: 'technical', label: '专业能力面试', description: '岗位知识与实践' },
  { value: 'behavioral', label: '行为面试', description: '真实经历与协作' },
  { value: 'pressure', label: '压力面试', description: '应变与取舍' },
]
const difficultyOptions: { value: InterviewConfig['difficulty']; label: string }[] = [
  { value: 'basic', label: '基础' }, { value: 'standard', label: '标准' }, { value: 'challenge', label: '挑战' },
]
const durationOptions: InterviewConfig['durationMinutes'][] = [5, 10, 15]
const defaultConfig: InterviewConfig = { role: 'frontend', type: 'general', difficulty: 'standard', durationMinutes: 10 }

function savedDraft(): InterviewConfig {
  try { return { ...defaultConfig, ...JSON.parse(sessionStorage.getItem('yingda.draft') || 'null') } }
  catch { return defaultConfig }
}

export function InterviewSetup() {
  const navigate = useNavigate()
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadRun = useRef(0)
  const [config, setConfig] = useState<InterviewConfig>(savedDraft)
  const [uploading, setUploading] = useState(false)
  const [resumeError, setResumeError] = useState('')
  const [resumeNotice, setResumeNotice] = useState('')
  const [saveError, setSaveError] = useState('')

  function update<K extends keyof InterviewConfig>(key: K, value: InterviewConfig[K]) {
    setConfig(current => ({ ...current, [key]: value }))
  }

  async function onResumeSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    const run = ++uploadRun.current
    setResumeError('')
    setResumeNotice('')
    setUploading(true)
    try {
      const result = await parseResume(file)
      if (run !== uploadRun.current) return
      setConfig(current => ({
        ...current,
        resumeText: result.text,
        resumeFileName: file.name.slice(0, 200),
      }))
      setResumeNotice(result.truncated
        ? '已提取前 8,000 字用于生成问题；其余内容未使用。'
        : '文字提取完成，将用于生成与你经历相关的问题。')
    } catch (error) {
      if (run === uploadRun.current) {
        setResumeError(error instanceof Error ? error.message : '简历读取失败，请换一份文件重试。')
      }
    } finally {
      if (run === uploadRun.current) setUploading(false)
    }
  }

  function removeResume() {
    uploadRun.current += 1
    setUploading(false)
    setResumeError('')
    setResumeNotice('')
    setConfig(current => ({ ...current, resumeText: undefined, resumeFileName: undefined }))
  }

  function next() {
    if (uploading) return
    clearFormalContext()
    const draft = {
      ...config,
      targetRoleDescription: config.targetRoleDescription?.trim().slice(0, 300) || undefined,
      resumeText: config.resumeText?.slice(0, MAX_RESUME_TEXT) || undefined,
    }
    try {
      sessionStorage.setItem('yingda.draft', JSON.stringify(draft))
      navigate('/device-check')
    } catch {
      setSaveError('浏览器无法保存本次配置。请检查是否禁用网站存储后重试。')
    }
  }

  return <div className="container page-spacing setup-page">
    <button className="back-link" onClick={() => navigate('/')}><ArrowLeft size={17} />返回首页</button>
    <div className="page-heading">
      <span className="section-kicker">开始之前</span>
      <h1>定制这场练习</h1>
      <p>说明目标岗位，也可以提供简历。DeepSeek 将根据你的选择与经历安排面试题目。</p>
    </div>
    <div className="setup-layout">
      <div className="setup-form">
        <section className="setting-section">
          <div className="setting-title"><span className="setting-icon"><BriefcaseBusiness size={20} /></span><div><h2>目标岗位</h2><p>选择与你求职方向最接近的一项</p></div></div>
          <div className="option-grid roles">{roleOptions.map(item => <button type="button" className={config.role === item.value ? 'option-card selected' : 'option-card'} key={item.value} onClick={() => update('role', item.value)}><b>{item.label}</b><small>{item.description}</small></button>)}</div>
          <label className="setup-field-label" htmlFor="target-role-description">具体岗位与面试重点 <span>选填</span></label>
          <textarea id="target-role-description" className="setup-textarea" maxLength={300} rows={3} value={config.targetRoleDescription || ''} onChange={event => update('targetRoleDescription', event.target.value)} placeholder="例如：应聘电商平台前端工程师，希望重点练习 React 性能优化、复杂表单与跨团队协作。" />
          <p className="setup-field-hint">写出岗位方向、业务场景或职位要求，提问会更贴近你的目标。<span>{(config.targetRoleDescription || '').length}/300</span></p>
        </section>

        <section className="setting-section">
          <div className="setting-title"><span className="setting-icon"><FileText size={20} /></span><div><h2>个人简历</h2><p>选填，可让提问结合你的项目经历</p></div></div>
          <input ref={fileInput} className="setup-file-input" type="file" accept=".pdf,.docx,.txt,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={event => void onResumeSelected(event)} aria-label="选择简历文件" />
          {config.resumeText && config.resumeFileName ? <div className="resume-attached">
            <span className="resume-file-icon"><FileText size={21} /></span>
            <div className="resume-file-info"><strong title={config.resumeFileName}>{config.resumeFileName}</strong><span>{config.resumeText.length.toLocaleString()} 字已提取 · PDF / DOCX / TXT</span></div>
            <button type="button" className="resume-remove" onClick={removeResume} aria-label="移除简历"><X size={17} /></button>
          </div> : <button type="button" className="resume-upload" onClick={() => fileInput.current?.click()} disabled={uploading}>
            <span className="resume-upload-icon">{uploading ? <LoaderCircle size={22} className="resume-spin" /> : <UploadCloud size={22} />}</span>
            <strong>{uploading ? '正在本地提取简历文字…' : '选择简历文件'}</strong>
            <small>支持 PDF、DOCX、TXT，最大 8 MB；扫描版 PDF 需先识别文字</small>
          </button>}
          {config.resumeText && <button type="button" className="resume-replace" onClick={() => fileInput.current?.click()} disabled={uploading}>更换简历</button>}
          {resumeNotice && <p className="setup-inline-note success" role="status"><CheckCircle2 size={15} />{resumeNotice}</p>}
          {resumeError && <p className="setup-inline-note error" role="alert"><AlertCircle size={15} />{resumeError}</p>}
          <p className="resume-privacy">仅在浏览器中提取文字，原文件不会上传或保存在历史记录中。提取的文字会发送至 AI，用于生成本次面试题。</p>
        </section>

        <section className="setting-section">
          <div className="setting-title"><span className="setting-icon"><MessageCircleMore size={20} /></span><div><h2>面试类型</h2><p>决定题目角度与追问方向</p></div></div>
          <div className="option-grid types">{typeOptions.map(item => <button type="button" className={config.type === item.value ? 'option-card selected' : 'option-card'} key={item.value} onClick={() => update('type', item.value)}><b>{item.label}</b><small>{item.description}</small></button>)}</div>
        </section>
        <section className="setting-section">
          <div className="setting-title"><span className="setting-icon"><Gauge size={20} /></span><div><h2>难度</h2><p>从基础表达，到有挑战的深入追问</p></div></div>
          <div className="segmented">{difficultyOptions.map(item => <button type="button" className={config.difficulty === item.value ? 'active' : ''} onClick={() => update('difficulty', item.value)} key={item.value}>{item.label}</button>)}</div>
        </section>
        <section className="setting-section">
          <div className="setting-title"><span className="setting-icon"><Clock3 size={20} /></span><div><h2>面试时长</h2><p>根据时长安排题数，到时会自动生成报告</p></div></div>
          <div className="segmented">{durationOptions.map(item => <button type="button" className={config.durationMinutes === item ? 'active' : ''} onClick={() => update('durationMinutes', item)} key={item}>{item} 分钟</button>)}</div>
        </section>
      </div>
      <aside className="setup-summary">
        <span className="summary-label">本次练习</span>
        <h3>{roleOptions.find(item => item.value === config.role)?.label}</h3>
        {config.targetRoleDescription && <p className="summary-role">{config.targetRoleDescription}</p>}
        <div className="summary-detail"><span>面试类型</span><b>{typeOptions.find(item => item.value === config.type)?.label}</b></div>
        <div className="summary-detail"><span>难度设置</span><b>{difficultyOptions.find(item => item.value === config.difficulty)?.label}</b></div>
        <div className="summary-detail"><span>预计时长</span><b>{config.durationMinutes} 分钟</b></div>
        <div className="summary-detail"><span>简历参考</span><b>{config.resumeText ? '已添加' : '未添加'}</b></div>
        <div className="summary-rule" />
        <p>下一步检测摄像头与麦克风。没有摄像头时，也可以继续文字面试。</p>
        {saveError && <p className="setup-inline-note error" role="alert"><AlertCircle size={15} />{saveError}</p>}
        <button className="button button-primary full" onClick={next} disabled={uploading}>检查设备并继续 <ArrowRight size={18} /></button>
      </aside>
    </div>
  </div>
}
