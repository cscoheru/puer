// Tea type
export const TEA_TYPES = [
  { value: "raw", label: "生茶" },
  { value: "ripe", label: "熟茶" },
] as const;

// Weight specs
export const WEIGHT_SPECS = [
  { value: "200g", label: "200克" },
  { value: "250g", label: "250克" },
  { value: "357g", label: "357克" },
  { value: "400g", label: "400克" },
  { value: "500g", label: "500克" },
  { value: "other", label: "其他" },
] as const;

// Storage conditions
export const STORAGE_TYPES = [
  { value: "dry_high_aroma", label: "干仓高香" },
  { value: "dry_normal", label: "干仓非高香" },
  { value: "home_natural", label: "家庭自然仓" },
  { value: "wet", label: "湿仓" },
] as const;

// Source channels
export const SOURCE_TYPES = [
  { value: "factory_direct", label: "厂家一手" },
  { value: "merchant_secondary", label: "茶商二手" },
  { value: "other", label: "其他" },
] as const;

// Acquisition types
export const ACQUISITION_TYPES = [
  { value: "swap", label: "置换" },
  { value: "purchase", label: "购买" },
] as const;

// Trade methods
export const TRADE_METHODS = [
  { value: "self_delivery", label: "自行交易" },
  { value: "platform_verification", label: "平台验货" },
] as const;

// Trade request statuses
export const TRADE_REQUEST_STATUSES = [
  { value: "pending", label: "待处理" },
  { value: "accepted", label: "已接受" },
  { value: "rejected", label: "已拒绝" },
  { value: "confirmed", label: "已确认" },
  { value: "cancelled", label: "已取消" },
  { value: "superseded", label: "已被取代" },
] as const;

// Lookup helpers
export function teaTypeLabel(v: string) {
  return TEA_TYPES.find((t) => t.value === v)?.label ?? v;
}
export function storageLabel(v: string) {
  return STORAGE_TYPES.find((s) => s.value === v)?.label ?? v;
}
export function sourceLabel(v: string) {
  return SOURCE_TYPES.find((s) => s.value === v)?.label ?? v;
}
export function specLabel(v: string) {
  return WEIGHT_SPECS.find((s) => s.value === v)?.label ?? v;
}
export function requestStatusLabel(v: string) {
  return TRADE_REQUEST_STATUSES.find((s) => s.value === v)?.label ?? v;
}
