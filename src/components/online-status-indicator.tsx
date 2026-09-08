"use client";

interface Props {
  status: string; // online | offline | busy
  size?: "sm" | "md";
  showLabel?: boolean;
}

const COLORS: Record<string, string> = {
  online: "bg-green-500",
  offline: "bg-gray-400",
  busy: "bg-yellow-400",
};

const LABELS: Record<string, string> = {
  online: "在线",
  offline: "离线",
  busy: "忙碌",
};

export default function OnlineStatusIndicator({ status, size = "sm", showLabel }: Props) {
  const dotSize = size === "md" ? "w-2.5 h-2.5" : "w-2 h-2";
  return (
    <span className="inline-flex items-center gap-1" title={LABELS[status] || "离线"}>
      <span className={`${dotSize} rounded-full ${COLORS[status] || COLORS.offline} flex-shrink-0`} />
      {showLabel && (
        <span className="text-xs text-stone-400">{LABELS[status] || "离线"}</span>
      )}
    </span>
  );
}
