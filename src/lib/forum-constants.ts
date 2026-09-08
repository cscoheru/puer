export const FLAIRS = [
  { value: "tasting", label: "开汤", color: "bg-orange-100 text-orange-700" },
  { value: "question", label: "请教", color: "bg-blue-100 text-blue-700" },
  { value: "share", label: "分享", color: "bg-green-100 text-green-700" },
  { value: "discussion", label: "讨论", color: "bg-purple-100 text-purple-700" },
  { value: "science", label: "科普", color: "bg-cyan-100 text-cyan-700" },
  { value: "help", label: "求助", color: "bg-red-100 text-red-700" },
  { value: "show", label: "晒茶", color: "bg-amber-100 text-amber-700" },
  { value: "original", label: "原创", color: "bg-indigo-100 text-indigo-700" },
] as const;

export function getFlair(value: string | null) {
  if (!value) return null;
  return FLAIRS.find((f) => f.value === value) || null;
}
