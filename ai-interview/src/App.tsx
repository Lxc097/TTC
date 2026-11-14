import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { AudioLines, Menu, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Home } from './pages/Home'
import { InterviewSetup } from './pages/InterviewSetup'
import { DeviceCheck } from './pages/DeviceCheck'
import { InterviewHistory } from './pages/InterviewHistory'
import { JoinInterview } from './pages/JoinInterview'
import { WaitingRoom } from './pages/WaitingRoom'
import { FormalInvitation } from './pages/FormalInvitation'
import { getFormalContext } from './services/formalInterview'

const InterviewSession = lazy(() => import('./pages/InterviewSession').then(module => ({default:module.InterviewSession})))
const InterviewReportPage = lazy(() => import('./pages/InterviewReportPage').then(module => ({default:module.InterviewReportPage})))

function DeviceCheckRoute() {
  const navigate = useNavigate()
  const formal = new URLSearchParams(window.location.search).get('formal') === '1' ? getFormalContext() : null
  const mode = new URLSearchParams(window.location.search).get('mode') === 'room' ? 'room' : 'mock'
  if (new URLSearchParams(window.location.search).get('formal') === '1' && !formal) return <Navigate to="/" replace />
  return <DeviceCheck mode={mode} formal={Boolean(formal)} onBack={() => navigate(formal ? '/?application=' + encodeURIComponent(formal.applicationId) : mode === 'room' ? '/join' : '/setup')} onContinue={(payload) => {
    sessionStorage.setItem('yingda.devices', JSON.stringify(payload))
    navigate(mode === 'room' ? '/waiting' : '/interview')
  }} />
}

export default function App() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const close = () => setMobileOpen(false)
  const applicationId = new URLSearchParams(window.location.search).get('application')
  const formalSurface = Boolean(applicationId || getFormalContext())
  useEffect(() => {
    document.title = formalSurface ? '天镜 · 岗位 AI 初面' : '天镜 Practice · AI 模拟面试'
  }, [formalSurface])

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="container header-inner">
          <NavLink className="brand" to="/" onClick={close} aria-label="天镜 Practice 首页">
            <span className="brand-mark"><AudioLines size={22} strokeWidth={2.3} /></span>
            <span>天镜<span className="brand-en">Practice</span></span>
          </NavLink>
          <button className="mobile-menu" aria-label={mobileOpen ? '关闭导航' : '打开导航'} onClick={() => setMobileOpen(!mobileOpen)}>{mobileOpen ? <X size={22} /> : <Menu size={22} />}</button>
          <nav className={mobileOpen ? 'nav-links nav-open' : 'nav-links'} aria-label="主导航">
            {formalSurface ? <a href="/personal/applications.html">我的申请</a> : <>
            <NavLink onClick={close} to="/" end>首页</NavLink>
            <NavLink onClick={close} to="/setup">模拟面试</NavLink>
            <NavLink onClick={close} to="/history">面试记录</NavLink>
            <NavLink onClick={close} to="/join">加入面试</NavLink>
            </>}
          </nav>
          {formalSurface ? <a className="header-action" href="/personal/applications.html">返回申请 <span aria-hidden="true">↗</span></a> : <NavLink className="header-action" to="/setup">开始练习 <span aria-hidden="true">↗</span></NavLink>}
        </div>
      </header>
      <main>
        <Suspense fallback={<div className="route-loading" role="status">正在打开页面…</div>}><Routes>
          <Route path="/" element={applicationId ? <FormalInvitation applicationId={applicationId} /> : <Home />} />
          <Route path="/setup" element={<InterviewSetup />} />
          <Route path="/device-check" element={<DeviceCheckRoute />} />
          <Route path="/interview" element={<InterviewSession />} />
          <Route path="/report/:id" element={<InterviewReportPage />} />
          <Route path="/history" element={<InterviewHistory />} />
          <Route path="/join" element={<JoinInterview />} />
          <Route path="/waiting" element={<WaitingRoom />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes></Suspense>
      </main>
      <footer className="site-footer">
        <div className="container footer-inner"><span>{formalSurface ? '天镜 · 岗位 AI 初面' : '天镜 Practice · 为每一次更好的表达而练习'}</span><span>{formalSurface ? '企业内部简历初筛结果不会在这里展示' : '个人端演示版 · 原始视频不会保存在本地记录中'}</span></div>
      </footer>
    </div>
  )
}
