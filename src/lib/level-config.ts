import { prisma } from "@/lib/prisma";

export interface LevelConfigEntry {
  level: number;
  name: string;
  expRequired: number;
  daysRequired: number;
  postsRequired: number;
  commentsLikedRequired: number;
}

let cachedLevels: LevelConfigEntry[] | null = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getLevelConfigs(): Promise<LevelConfigEntry[]> {
  const now = Date.now();
  if (cachedLevels && now < cacheExpiry) {
    return cachedLevels;
  }

  cachedLevels = await prisma.levelConfig.findMany({
    orderBy: { level: "asc" },
  });
  cacheExpiry = now + CACHE_TTL;
  return cachedLevels;
}

export async function getLevelName(level: number): Promise<string> {
  const configs = await getLevelConfigs();
  return configs.find((c) => c.level === level)?.name ?? `Lv.${level}`;
}

export async function getLevelRequirements(level: number): Promise<LevelConfigEntry | undefined> {
  const configs = await getLevelConfigs();
  return configs.find((c) => c.level === level);
}

export function invalidateLevelCache(): void {
  cachedLevels = null;
  cacheExpiry = 0;
}
