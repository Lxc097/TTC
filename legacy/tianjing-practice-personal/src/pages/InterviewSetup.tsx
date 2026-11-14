import { useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, FileText, LoaderCircle, UploadCloud, X } from 'lucide-react'
import type { InterviewConfig, InterviewRole } from '../types/interview'
import { MAX_RESUME_TEXT, parseResume } from '../utils/resume'
import './InterviewSetup.css'

const typeOptions: { value: InterviewConfig['type']; label: string; description: string }[] = [
  { value: 'general', label: '综合面试', description: '能力与经历' },
  { value: 'technical', label: '专业能力', description: '知识与实践' },
  { value: 'behavioral', label: '行为面试', description: '经历与协作' },
  { value: 'pressure', label: '压力面试', description: '应变与取舍' },
]
const difficultyOptions: { value: InterviewConfig['difficulty']; label: string }[] = [
  { value: 'basic', label: '基础' }, { value: 'standard', label: '标准' }, { value: 'challenge', label: '挑战' },
]
const durationOptions: InterviewConfig['durationMinutes'][] = [5, 10, 15]
const defaultConfig: InterviewConfig = {
  targetRole: '', role: 'general', type: 'general', difficulty: 'standard', durationMinutes: 10,
}

function savedDraft(): InterviewConfig {
  try {
    const saved = JSON.parse(sessionStorage.getItem('yingda.draft') || 'null')
    return saved && typeof saved === 'object'
      ? { ...defaultConfig, ...saved, targetRole: typeof saved.targetRole === 'string' ? saved.targetRole : '' }
      : defaultConfig
  } catch { return defaultConfig }
}

/** The local question bank uses broad categories; AI receives the exact free-text role. */
function fallbackRole(targetRole: string): InterviewRole {
  const role = targetRole.toLowerCase()
  if (/前端|react|vue|web|网页|ui工程/.test(role)) return 'frontend'
  if (/后端|服务端|java|go语言|golang|数据库/.test(role)) return 'backend'
  if (/产品经理|产品设计|产品运营/.test(role)) return 'product'
  if (/市场|营销|增长|新媒体|内容运营/.test(role)) return 'marketing'
  return 'general'
}

export function InterviewSetup() {
  const navigate = useNavigate()
  const fileInput = useRef<HTMLInputElement>(null)
  const roleInput = useRef<HTMLInputElement>(null)
  const uploadRun = useRef(0)
  const [config, setConfig] = useState<InterviewConfig>(savedDraft)
  const [uploading, setUploading] = useState(false)
  const [resumeError, setResumeError] = useState('')
  const [resumeNotice, setResumeNotice] = useState('')
  const [formError, setFormError] = useState('')

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
      setConfig(current => ({ ...current, resumeText: result.text, resumeFileName: file.name.slice(0, 200) }))
      setResumeNotice(result.truncated ? '已提取前 8,000 字用于生成问题。' : '简历文字已提取，将用于生成贴合经历的问题。')
    } catch (error) {
      if (run === uploadRun.current) setResumeError(error instanceof Error ? error.message : '简历读取失败，请更换文件。')
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
    const targetRole = config.targetRole.trim()
    if (!targetRole) {
      setFormError('请先填写目标岗位。')
      roleInput.current?.focus()
      return
    }
    const draft: InterviewConfig = {
      ...config,
      targetRole,
      role: fallbackRole(targetRole),
      targetRoleDescription: config.targetRoleDescription?.trim().slice(0, 300) || undefined,
      resumeText: config.resumeText?.slice(0, MAX_RESUME_TEXT) || undefined,
    }
    try {
      sessionStorage.setItem('yingda.draft', JSON.stringify(draft))
      navigate('/device-check')
    } catch { setFormError('浏览器无法保存配置。请检查网站存储权限后重试。') }
  }

  return <div className="container setup-page">
    <button className="back-link" type="button" onClick={() => navigate('/')}><ArrowLeft size={16} />返回首页</button>
    <header className="setup-page__heading">
      <span className="section-kicker">模拟面试 · 第一步</span>
      <h1>定制这场练习</h1>
      <p>告诉我们目标岗位，天镜将结合你的经历安排提问。</p>
    </header>
    <main className="setup-compact-form">
      <div className="setup-compact-field">
        <label className="setup-compact-label" htmlFor="target-role">目标岗位 <span className="setup-required">必填</span></label>
        <input ref={roleInput} id="target-role" className="setup-role-input" type="text" maxLength={80} value={config.targetRole}
          aria-invalid={Boolean(formError && !config.targetRole.trim())}
          onChange={event => { update('targetRole', event.target.value); setFormError('') }}
          placeholder="请输入目标岗位，例如：大模型应用工程师、产品经理、嵌入式开发工程师" />
      </div>
      <fieldset className="setup-compact-field setup-type-field">
        <legend className="setup-compact-label">面试类型</legend>
        <div className="setup-type-grid">{typeOptions.map(item => <button type="button" aria-pressed={config.type === item.value}
          className={'setup-type-option' + (config.type === item.value ? ' is-selected' : '')} key={item.value}
          onClick={() => update('type', item.value)}><strong>{item.label}</strong><small>{item.description}</small></button>)}</div>
      </fieldset>
      <div className="setup-compact-pair">
        <fieldset className="setup-compact-field">
          <legend className="setup-compact-label">面试难度</legend>
          <div className="setup-choice-group">{difficultyOptions.map(item => <button type="button" aria-pressed={config.difficulty === item.value}
            className={config.difficulty === item.value ? 'is-selected' : ''} key={item.value}
            onClick={() => update('difficulty', item.value)}>{item.label}</button>)}</div>
        </fieldset>
        <fieldset className="setup-compact-field">
          <legend className="setup-compact-label">预计时长</legend>
          <div className="setup-choice-group">{durationOptions.map(item => <button type="button" aria-pressed={config.durationMinutes === item}
            className={config.durationMinutes === item ? 'is-selected' : ''} key={item}
            onClick={() => update('durationMinutes', item)}>{item} 分钟</button>)}</div>
        </fieldset>
      </div>
      <div className="setup-compact-field">
        <label className="setup-compact-label" htmlFor="target-role-description">具体岗位与面试重点 <span>选填</span></label>
        <textarea id="target-role-description" className="setup-focus-input" maxLength={300} rows={2}
          value={config.targetRoleDescription || ''} onChange={event => update('targetRoleDescription', event.target.value)}
          placeholder="例如：重点练习多模态应用架构、项目经历与跨团队协作。" />
      </div>
      <div className="setup-compact-field">
        <div className="setup-resume-heading"><label className="setup-compact-label" htmlFor="resume-file">个人简历 <span>选填</span></label><small>PDF / DOCX / TXT · 最大 8 MB</small></div>
        <input ref={fileInput} id="resume-file" className="setup-file-input" type="file"
          accept=".pdf,.docx,.txt,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={event => void onResumeSelected(event)} aria-label="选择简历文件" />
        {config.resumeText && config.resumeFileName ? <div className="setup-resume-row">
          <FileText size={19} /><span title={config.resumeFileName}>{config.resumeFileName}</span>
          <small>{config.resumeText.length.toLocaleString()} 字</small>
          <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading}>更换</button>
          <button type="button" onClick={removeResume} aria-label="移除简历"><X size={16} /></button>
        </div> : <button type="button" className="setup-resume-pick" onClick={() => fileInput.current?.click()} disabled={uploading}>
          {uploading ? <LoaderCircle size={18} className="setup-spin" /> : <UploadCloud size={18} />}
          {uploading ? '正在提取简历文字…' : '选择简历文件，生成更贴合经历的问题'}
        </button>}
        {resumeNotice && <p className="setup-compact-note is-success" role="status"><CheckCircle2 size={14} />{resumeNotice}</p>}
        {resumeError && <p className="setup-compact-note is-error" role="alert"><AlertCircle size={14} />{resumeError}</p>}
      </div>
      <div className="setup-form-footer">
        <p>简历仅提取文字用于本次 AI 提问；不保存原文件。</p>
        <button type="button" className="button button-primary" onClick={next} disabled={uploading}>检查设备 <ArrowRight size={17} /></button>
      </div>
      {formError && <p className="setup-compact-note is-error" role="alert"><AlertCircle size={14} />{formError}</p>}
    </main>
  </div>
}
