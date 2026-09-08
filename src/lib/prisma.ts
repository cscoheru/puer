import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as any;

function makePrisma() {
  return new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
    log: [{ level: "query", emit: "stdout" }, { level: "warn", emit: "stdout" }, { level: "error", emit: "stdout" }],
  });
}

export const prisma: PrismaClient =
  globalForPrisma.__prisma ?? (globalForPrisma.__prisma = makePrisma());