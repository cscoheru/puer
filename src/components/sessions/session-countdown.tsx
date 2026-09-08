"use client";

import { useState, useEffect } from "react";

interface Props {
  targetDate: string; // ISO string
  onExpired?: () => void;
}

export default function SessionCountdown({ targetDate, onExpired }: Props) {
  const [remaining, setRemaining] = useState("");
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const target = new Date(targetDate).getTime();
    const tick = () => {
      const now = Date.now();
      const diff = target - now;
      if (diff <= 0) {
        setRemaining("已到时间");
        if (!expired) {
          setExpired(true);
          onExpired?.();
        }
        return;
      }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      if (h > 0) {
        setRemaining(`${h}小时${m}分${s}秒`);
      } else if (m > 0) {
        setRemaining(`${m}分${s}秒`);
      } else {
        setRemaining(`${s}秒`);
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [targetDate, onExpired, expired]);

  const isUrgent = !expired && (() => {
    const diff = new Date(targetDate).getTime() - Date.now();
    return diff > 0 && diff < 300000; // 5 min
  })();

  return (
    <span className={`font-mono text-sm ${expired ? "text-red-500" : isUrgent ? "text-red-600 font-semibold" : "text-amber-700"}`}>
      {remaining}
    </span>
  );
}
