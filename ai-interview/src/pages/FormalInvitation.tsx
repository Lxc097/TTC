import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { prepareFormalInterview, saveFormalContext } from '../services/formalInterview'

/** Opens an authorized application; the candidate never types the job or screening context. */
export function FormalInvitation({ applicationId }: { applicationId: string }) {
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    void prepareFormalInterview(applicationId).then(context => {
      if (!active) return
      saveFormalContext(context)
      sessionStorage.setItem('yingda.draft', JSON.stringify(context.config))
      navigate('/device-check?formal=1', { replace: true })
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : '无法打开初面邀请。')
    })
    return () => { active = false }
  }, [applicationId, navigate, retry])

  return <div className="room-page"><div className="room-loading" role={error ? 'alert' : 'status'}>
    <span className="section-kicker">岗位 AI 初面</span>
    <h1>{error ? '暂时无法进入初面' : '正在核对你的邀请'}</h1>
    <p>{error || '核对身份与岗位后，将进入设备检测。'}</p>
    {error && <div className="hero-actions">
      <button className="button button-primary" onClick={() => { setError(''); setRetry(value => value + 1) }}>重试</button>
      <a className="button button-secondary" href="/personal/applications.html">返回我的申请</a>
    </div>}
  </div></div>
}
