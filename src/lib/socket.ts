"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";

const WS_URL =
  (typeof window !== "undefined"
    ? process.env.NEXT_PUBLIC_WS_URL
    : undefined) || "";

interface UseSocketOptions {
  sessionId?: string;
  enabled?: boolean;
}

interface UseSocketReturn {
  socket: Socket | null;
  connected: boolean;
  error: string | null;
}

export function useSocket({
  sessionId,
  enabled = true,
}: UseSocketOptions): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let cancelled = false;

    async function connect() {
      try {
        const res = await fetch("/api/auth/ws-token");
        if (!res.ok) {
          setError("获取认证令牌失败");
          return;
        }
        const { token } = await res.json();
        if (cancelled) return;

        const socket = io(WS_URL, {
          auth: { token },
          transports: ["websocket", "polling"],
        });

        socket.on("connect", () => {
          if (cancelled) {
            socket.disconnect();
            return;
          }
          setConnected(true);
          setError(null);
          socket.emit("join_session", { sessionId });
        });

        socket.on("disconnect", (reason) => {
          setConnected(false);
          if (reason !== "io client disconnect") {
            setError("连接断开，正在重连...");
          }
        });

        socket.on("connect_error", (err) => {
          setError(err.message === "Invalid token" ? "认证失败" : "连接失败");
        });

        socketRef.current = socket;
      } catch {
        if (!cancelled) setError("无法连接到聊天服务器");
      }
    }

    connect();

    return () => {
      cancelled = true;
      const sock = socketRef.current;
      if (sock) {
        sock.emit("leave_session", { sessionId });
        sock.disconnect();
        socketRef.current = null;
        setConnected(false);
      }
    };
  }, [sessionId, enabled]);

  return { socket: socketRef.current, connected, error };
}
