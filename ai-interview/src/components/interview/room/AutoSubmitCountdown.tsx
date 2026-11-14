export function AutoSubmitCountdown({seconds,onCancel}:{seconds:number|null;onCancel:()=>void}) {
  if(seconds===null)return null
  return <div className="room-auto-countdown" role="status"><span>{seconds} 秒后自动提交回答</span><button type="button" onClick={onCancel}>取消</button></div>
}
