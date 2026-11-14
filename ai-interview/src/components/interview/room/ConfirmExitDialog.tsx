import { X } from 'lucide-react'

export function ConfirmExitDialog({open,onCancel,onConfirm}:{open:boolean;onCancel:()=>void;onConfirm:()=>void}) {
  if(!open)return null
  return <div className="room-dialog-backdrop" role="presentation" onMouseDown={onCancel}><div className="room-dialog" role="dialog" aria-modal="true" aria-labelledby="room-exit-title" onMouseDown={event=>event.stopPropagation()}><button className="room-dialog__close" onClick={onCancel} aria-label="关闭"><X size={19}/></button><span className="room-dialog__mark">结束面试</span><h2 id="room-exit-title">现在结束这场练习？</h2><p>已提交的回答会生成报告并保存在本机。当前尚未提交的文字不会计入评分。</p><div><button className="button button-secondary" onClick={onCancel}>继续面试</button><button className="button button-primary" onClick={onConfirm}>结束并查看报告</button></div></div></div>
}
