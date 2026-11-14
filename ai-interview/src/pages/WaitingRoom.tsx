import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Camera, CircleAlert, Clock3, UsersRound } from 'lucide-react'
import { getInterviewRoomStatus, leaveInterviewRoom, type InterviewRoomSession } from '../services/rooms'

export function WaitingRoom() {
  const navigate = useNavigate()
  const [session,setSession] = useState<InterviewRoomSession | null>(null)
  useEffect(() => { void getInterviewRoomStatus().then(setSession) }, [])
  async function leave() { await leaveInterviewRoom(); navigate('/join') }
  if (!session) return <div className="container page-spacing empty-state"><h1>还没有面试房间信息</h1><p>请先填写房间号和昵称。</p><button className="button button-primary" onClick={() => navigate('/join')}>前往加入页面</button></div>
  const device = (() => {try {return JSON.parse(sessionStorage.getItem('yingda.devices') || '{}') as {cameraEnabled?:boolean}} catch {return {}}})()
  return <div className="container page-spacing compact-page"><button className="back-link" onClick={() => navigate('/join')}><ArrowLeft size={17} />返回</button><div className="waiting-card"><div className="waiting-icon"><UsersRound size={31} /></div><span className="demo-badge">演示流程 · 尚未连接</span><h1>等候室已准备好</h1><p>你好，{session.nickname}。你的房间号是 <b>{session.roomId}</b>。当前个人端尚未连接企业房间服务，因此无法确认面试官状态，也不会显示虚假的“加入成功”。</p><div className="waiting-facts"><div><Clock3 size={18} /><span>房间状态</span><b>待接入服务</b></div><div><Camera size={18} /><span>摄像头检测</span><b>{device.cameraEnabled?'已在上一步通过':'文字模式'}</b></div></div><div className="waiting-note"><CircleAlert size={18} /><span>后续与企业端联调后，此处将展示真实房间状态、音视频连接和面试官入场提示。</span></div><button className="button button-secondary" onClick={() => void leave()}>离开演示等候室</button></div></div>
}
