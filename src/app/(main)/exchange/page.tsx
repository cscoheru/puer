import { prisma } from "@/lib/prisma";
import ExchangeClient from "./exchange-client";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "茶叶交易 - 买卖交换",
  description: "普洱茶交易市场。茶友间茶叶买卖、交换、转让信息发布平台。",
  keywords: ["普洱茶交易", "茶叶买卖", "茶友交换", "二手茶叶"],
  alternates: { canonical: "/exchange" },
};

export const dynamic = "force-dynamic";

export default async function ExchangePage() {
  // Pre-fetch brands for filter
  const brands = await prisma.teaInventoryItem.findMany({
    where: { status: "active", hidden: false, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { brand: true },
    distinct: ["brand"],
    orderBy: { brand: "asc" },
  });

  return <ExchangeClient brands={brands.map((b) => b.brand)} />;
}
