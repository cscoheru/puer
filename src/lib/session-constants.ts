export const SESSION_STATUS = {
  inviting: { label: "邀请中", color: "bg-purple-100 text-purple-700", dot: "bg-purple-400" },
  confirmed: { label: "已确认", color: "bg-blue-100 text-blue-700", dot: "bg-blue-400" },
  live: { label: "进行中", color: "bg-green-100 text-green-700", dot: "bg-green-500" },
  ended: { label: "已结束", color: "bg-gray-100 text-gray-500", dot: "bg-gray-400" },
  expired: { label: "已过期", color: "bg-red-100 text-red-500", dot: "bg-red-400" },
  cancelled: { label: "已取消", color: "bg-gray-100 text-gray-400", dot: "bg-gray-300" },
} as const;

export type SessionStatus = keyof typeof SESSION_STATUS;

export const BREW_METHODS = [
  { value: "gongfu", label: "功夫泡" },
  { value: "western", label: "西式泡" },
  { value: "coldbrew", label: "冷萃" },
  { value: "boiling", label: "煮茶" },
  { value: "grandpa", label: "玻璃杯" },
  { value: "other", label: "其他" },
] as const;

export const CHAT_DAILY_LIMIT = 10;

export const INVITE_MINIMUM = 2;
export const CREDIT_DEDUCT_NO_SHOW = 20;

export const WS_EVENTS = {
  SEND_MESSAGE: "send_message",
  NEW_MESSAGE: "new_message",
  JOIN_SESSION: "join_session",
  LEAVE_SESSION: "leave_session",
  USER_JOINED: "user_joined",
  USER_LEFT: "user_left",
  BREW_UPDATE: "brew_update",
  BREW_UPDATED: "brew_updated",
  SYSTEM_MESSAGE: "system_message",
  UPDATE_PRESENCE: "update_presence",
  PRESENCE_CHANGED: "presence_changed",
  GET_ONLINE_FRIENDS: "get_online_friends",
  NEW_INVITATION: "new_invitation",
  INVITATION_RESPONSE: "invitation_response",
  PARTICIPANT_COUNT: "participant_count",
  HOST_ENTERED: "host_entered",
} as const;
