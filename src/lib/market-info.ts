// 东和行情快照解析（P2-R2 经典普洱模块）
// marketInfo 存于 teas.marketInfo (Json)，由 scripts/import-classic-teas.mjs 写入：
// {skuId, name, price, unit, changePct, updatedAt, source}
export interface MarketInfo {
  price?: string;
  changePct?: number;
  updatedAt?: string;
  source?: string;
}

export function parseMarket(raw: unknown): MarketInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.price !== "string" && typeof m.price !== "number") return null;
  return {
    price: String(m.price),
    changePct: typeof m.changePct === "number" ? m.changePct : undefined,
    updatedAt: typeof m.updatedAt === "string" ? m.updatedAt : undefined,
    source: typeof m.source === "string" ? m.source : undefined,
  };
}
