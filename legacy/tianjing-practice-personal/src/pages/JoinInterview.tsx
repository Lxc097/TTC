import { FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Info, LockKeyhole, UsersRound } from 'lucide-react'
import { joinInterviewRoom } from '../services/rooms'

export function JoinInterview() {
  const navigate = useNavigate()
  const [roomId,setRoomId] = useState('')
  const [nickname,setNickname] = useState('')
  const [error,setError] = useState('')
  async function submit(event:FormEvent) {
    event.preventDefault()
    setError('')
    try { await joinInterviewRoom({roomId,nickname}); navigate('/device-check?mode=room') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法进入演示等候流程。') }
  }
  return <div className="container page-spacing compact-page"><button className="back-link" onClick={() => navigate('/')}><ArrowLeft size={17} />返回首页</button><div className="page-heading"><span className="section-kicker">企业联动入口</span><h1>加入真实面试</h1><p>填写团队提供的房间号，先完成设备检测，再进入等候室。</p></div>
    <div className="form-panel"><div className="form-illustration"><UsersRound size={26} /><h2>为正式对话做好准备</h2><p>当前仅开放个人端演示流程。房间服务尚未接入，输入信息不会验证房间存在或建立实时连接。</p><div><LockKeyhole size={16} />请勿输入密码或其他敏感信息</div></div><form onSubmit={submit} className="join-form"><label htmlFor="room-id">面试房间号</label><input id="room-id" value={roomId} onChange={e=>setRoomId(e.target.value)} placeholder="例如：ROOM-2026" maxLength={40} required /><label htmlFor="nickname">你的昵称</label><input id="nickname" value={nickname} onChange={e=>setNickname(e.target.value)} placeholder="面试官看到的称呼" maxLength={30} required />{error && <p role="alert" className="inline-error">{error}</p>}<button className="button button-primary full" type="submit">继续检测设备 <ArrowRight size={18} /></button><p className="form-hint"><Info size={15} />演示入口 · 尚未接入企业端房间服务</p></form></div>
  </div>
}
