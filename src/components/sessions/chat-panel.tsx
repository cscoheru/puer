"use client";

import { useState, useEffect, useRef } from "react";
import { Socket } from "socket.io-client";
import { WS_EVENTS, CHAT_DAILY_LIMIT } from "@/lib/session-constants";

type MessageUser = { id: string; username: string; avatar: string | null; level: number };

interface Message {
  id: string;
  type: string;
  content: string | null;
  imageUrl: string | null;
  userId: string;
  user: MessageUser;
  createdAt: string;
}

interface Props {
  socket: Socket | null;
  connected: boolean;
  sessionId: string;
  initialMessages: Message[];
  isLive: boolean;
  currentUser: { id: string; username: string; avatar: string | null; level: number } | null;
}

export default function ChatPanel({
  socket,
  connected,
  sessionId,
  initialMessages,
  isLive,
  currentUser,
}: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const canChat = isLive && currentUser && (currentUser.level ?? 0) >= 1;

  // Listen for new messages
  useEffect(() => {
    if (!socket) return;

    const onMessage = (msg: Message) => {
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    };

    const onBrew = (data: { type: string; content: string; user: MessageUser; steepNumber: number; createdAt: string }) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `brew-${data.steepNumber}-${data.createdAt}`,
          type: data.type,
          content: data.content,
          imageUrl: null,
          userId: data.user.id,
          user: data.user,
          createdAt: data.createdAt,
        },
      ]);
    };

    socket.on(WS_EVENTS.NEW_MESSAGE, onMessage);
    socket.on(WS_EVENTS.BREW_UPDATED, onBrew);

    return () => {
      socket.off(WS_EVENTS.NEW_MESSAGE, onMessage);
      socket.off(WS_EVENTS.BREW_UPDATED, onBrew);
    };
  }, [socket]);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const sendMessage = async () => {
    const trimmed = text.trim();
    if (!trimmed || !socket || sending) return;

    setSending(true);
    // Optimistic — server validates and broadcasts
    socket.emit(WS_EVENTS.SEND_MESSAGE, {
      sessionId,
      content: trimmed,
    });
    setText("");
    setSending(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-center py-8 text-stone-400 text-sm">
            还没有消息，来说点什么吧
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className="flex gap-2">
            <img
              src={msg.user.avatar || "/default-avatar.svg"}
              alt=""
              className="w-7 h-7 rounded-full object-cover mt-0.5 flex-shrink-0"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-stone-700">
                  {msg.user.username}
                </span>
                <span className="text-xs text-stone-300">
                  Lv.{msg.user.level}
                </span>
              </div>
              {msg.type === "system" ? (
                <p className="text-sm text-stone-400 italic">{msg.content}</p>
              ) : msg.type === "brew_log" ? (
                <div className="text-sm">
                  <span className="text-amber-600 font-medium">🫖 冲泡记录</span>
                  <p className="text-stone-600">{msg.content}</p>
                </div>
              ) : (
                <div>
                  <p className="text-sm text-stone-700 whitespace-pre-wrap break-words">
                    {msg.content}
                  </p>
                  {msg.imageUrl && (
                    <img
                      src={msg.imageUrl}
                      alt=""
                      className="mt-1 max-w-48 rounded-lg"
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-amber-100 p-3">
        {!connected && (
          <p className="text-xs text-amber-600 mb-2">正在连接...</p>
        )}
        {!canChat ? (
          <p className="text-xs text-stone-400 text-center py-2">
            {!currentUser
              ? "登录后可参与聊天"
              : !isLive
              ? "茶席已结束"
              : "Lv.1 以上可发言"}
          </p>
        ) : (
          <div className="flex gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="说点什么..."
              maxLength={500}
              className="flex-1 px-3 py-2 border border-amber-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 text-sm"
            />
            <button
              onClick={sendMessage}
              disabled={sending || !text.trim()}
              className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition text-sm font-medium disabled:opacity-50"
            >
              发送
            </button>
          </div>
        )}
        {currentUser && (
          <p className="text-xs text-stone-300 mt-1">
            每日限制 {CHAT_DAILY_LIMIT} 条
          </p>
        )}
      </div>
    </div>
  );
}
