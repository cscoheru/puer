import { prisma } from "@/lib/prisma";

const UID_MIN = 1001;
const UID_MAX = 9999;

export async function allocateNextUid(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]): Promise<number> {
  const maxResult = await tx.user.aggregate({ _max: { uid: true } });
  const nextUid = Math.max((maxResult._max.uid ?? 1000) + 1, UID_MIN);
  if (nextUid > UID_MAX) {
    throw new Error("UID range exhausted (1001-9999)");
  }
  return nextUid;
}
