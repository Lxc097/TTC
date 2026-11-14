export interface InterviewRoomRequest { roomId: string; nickname: string }
export type InterviewRoomStatus = 'demo_waiting' | 'connected' | 'closed'
export interface InterviewRoomSession extends InterviewRoomRequest {
  status: InterviewRoomStatus
  mode: 'demo' | 'live'
  joinedAt: string
  message: string
}

const ROOM_SESSION_KEY = 'yingda.room.session'

/** TODO: Replace this demo adapter after agreeing on enterprise room API contracts. */
export async function joinInterviewRoom(request: InterviewRoomRequest): Promise<InterviewRoomSession> {
  if (!request.roomId.trim() || !request.nickname.trim()) throw new Error('请填写房间号和昵称。')
  const session: InterviewRoomSession = {
    roomId: request.roomId.trim(), nickname: request.nickname.trim(),
    status: 'demo_waiting', mode: 'demo', joinedAt: new Date().toISOString(),
    message: '演示流程：尚未连接企业端房间服务，不能确认房间是否存在。',
  }
  sessionStorage.setItem(ROOM_SESSION_KEY, JSON.stringify(session))
  return session
}

export async function getInterviewRoomStatus(): Promise<InterviewRoomSession | null> {
  try { return JSON.parse(sessionStorage.getItem(ROOM_SESSION_KEY) || 'null') as InterviewRoomSession | null }
  catch { return null }
}

export async function leaveInterviewRoom(): Promise<void> {
  sessionStorage.removeItem(ROOM_SESSION_KEY)
}
