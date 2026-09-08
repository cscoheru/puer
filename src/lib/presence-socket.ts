"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { useSession } from "next-auth/react";
import { WS_EVENTS } from "@/lib/session-constants";

const WS_URL =
  (typeof window !== "undefined"
    ? process.env.NEXT_PUBLIC_WS_URL
    : undefined) || "";

export interface UsePresenceSocketReturn {
  socket: Socket | null;
  connected: boolean;
  error: string | null;
  updatePresence: (status: "online" | "offline" | "busy") => void;
}

export function usePresenceSocket(): UsePresenceSocketReturn {
  const { data: session } = useSession();
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session?.user) return;
    let cancelled = false;

    async function connect() {
      try {
        const res = await fetch("/api/auth/ws-token");
        if (!res.ok) return;
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
        });

        socket.on("disconnect", (reason) => {
          setConnected(false);
          if (reason !== "io client disconnect") {
            setError("连接断开");
          }
        });

        socket.on("connect_error", () => {
          setError("连接失败");
        });

        // Invitation push notification — dispatch as DOM event for any listener
        socket.on(WS_EVENTS.NEW_INVITATION, (data) => {
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("tea-invitation", { detail: data }));
          }
        });

        // Invitation response notification for session host
        socket.on(WS_EVENTS.INVITATION_RESPONSE, (data) => {
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("tea-invitation-response", { detail: data }));
          }
        });

        socketRef.current = socket;
      } catch {
        if (!cancelled) setError("无法连接到服务器");
      }
    }

    connect();

    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [session?.user]);

  const updatePresence = useCallback((status: "online" | "offline" | "busy") => {
    socketRef.current?.emit(WS_EVENTS.UPDATE_PRESENCE, { status });
  }, []);

  return { socket: socketRef.current, connected, error, updatePresence };
}
