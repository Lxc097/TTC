import { Camera, CameraOff, Check, ChevronDown, ChevronUp, Keyboard, Mic, MicOff, SkipForward, Square, Volume2, VolumeX } from 'lucide-react'
import type { InterviewPhase } from '../../../types/interviewRoom'
import { AutoSubmitCountdown } from './AutoSubmitCountdown'

interface InterviewControlDockProps {
  phase:InterviewPhase
  micOn:boolean
  cameraOn:boolean
  muted:boolean
  autoSubmit:boolean
  countdown:number|null
  draft:string
  textOpen:boolean
  busy:boolean
  onToggleMic:()=>void
  onToggleCamera:()=>void
  onToggleMute:()=>void
  onAutoSubmitChange:(enabled:boolean)=>void
  onTextOpenChange:(open:boolean)=>void
  onDraftChange:(text:string)=>void
  onSubmit:()=>void
  onSkip:()=>void
  onCancelCountdown:()=>void
  onExit:()=>void
}

export function InterviewControlDock(props:InterviewControlDockProps) {
  return <div className="room-dock-wrap"><AutoSubmitCountdown seconds={props.countdown} onCancel={props.onCancelCountdown}/><section className="room-dock" aria-label="面试控制栏"><div className="room-dock__actions"><button type="button" className={props.micOn?'room-dock__icon is-on':'room-dock__icon'} onClick={props.onToggleMic} aria-label={props.micOn?'关闭麦克风':'开启麦克风'} title={props.micOn?'关闭麦克风':'开启麦克风'}>{props.micOn?<Mic size={20}/>:<MicOff size={20}/>}<small>麦克风</small></button><button type="button" className={props.cameraOn?'room-dock__icon is-on':'room-dock__icon'} onClick={props.onToggleCamera} aria-label={props.cameraOn?'关闭摄像头':'开启摄像头'} title={props.cameraOn?'关闭摄像头':'开启摄像头'}>{props.cameraOn?<Camera size={20}/>:<CameraOff size={20}/>}<small>摄像头</small></button><button type="button" className={props.textOpen?'room-dock__icon is-on':'room-dock__icon'} onClick={()=>props.onTextOpenChange(!props.textOpen)} aria-label="文字输入"><Keyboard size={20}/><small>文字输入</small></button><button type="button" className={props.muted?'room-dock__icon':'room-dock__icon is-on'} onClick={props.onToggleMute} aria-label={props.muted?'开启问题朗读':'关闭问题朗读'}>{props.muted?<VolumeX size={20}/>:<Volume2 size={20}/>}<small>朗读</small></button></div><div className="room-dock__separator"/><label className="room-dock__auto"><input type="checkbox" checked={props.autoSubmit} onChange={event=>props.onAutoSubmitChange(event.target.checked)}/><span className="room-switch"/><span>自动完成<small>静音 8 秒后</small></span></label><div className="room-dock__right"><button type="button" className="room-dock__skip" onClick={props.onSkip} disabled={props.busy}><SkipForward size={17}/>跳过</button><button type="button" className="room-dock__submit" onClick={props.onSubmit} disabled={props.busy||!props.draft.trim()}><Check size={17}/>{props.busy?'处理中':'完成回答'}</button><button type="button" className="room-dock__exit" onClick={props.onExit} title="结束面试" aria-label="结束面试"><Square size={16}/></button></div></section>{props.textOpen&&<div className="room-dock__editor"><label htmlFor="room-answer-input">我的回答 · 可直接打字</label><textarea id="room-answer-input" value={props.draft} onChange={event=>props.onDraftChange(event.target.value)} rows={3} placeholder="听不到朗读或语音识别失败？直接在这里输入回答，再点击“完成回答”。"/><button type="button" onClick={()=>props.onTextOpenChange(false)}><ChevronDown size={16}/>收起输入框</button></div>}<button type="button" className="room-dock__mobile-toggle" onClick={()=>props.onTextOpenChange(!props.textOpen)}>{props.textOpen?<ChevronDown size={17}/>:<ChevronUp size={17}/>} {props.textOpen?'收起文字输入':'展开文字输入'}</button></div>
}
