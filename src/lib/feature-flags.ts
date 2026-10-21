/**
 * Feature flags — PRD v0.3 §0「所有新功能走 feature flag」。
 *
 * 设计要点：
 *  - 每个 flag 有**代码内的默认值**与**环境变量覆盖**。环境变量优先，
 *    这样线上要临时关掉某个功能，改 .env 重启即可，不用发版。
 *  - 判定是纯函数（读 env 的那层除外），可单测。
 *  - 反滥用类的 flag 默认**开**：限速/防盗链这类保护如果默认关，等于
 *    没有任何保护，而「临时关掉」的需求由环境变量满足。需要真正默认关的
 *    新功能，把 DEFAULTS 里对应项改成 false 即可。
 *
 * 环境变量命名：FEATURE_<SCREAMING_SNAKE_NAME>，取值 1/true/yes/on = 开，
 * 0/false/no/off = 关。
 */

/** flag 清单。新增 flag 必须同时加到 DEFAULTS 与 ENV_KEYS。 */
export const FEATURE_FLAGS = {
  /** 反滥用：按 IP 限速 + 批量遍历检测（proxy 层） */
  antiAbuseRateLimit: true,
  /** 反滥用：列表翻页深度上限（路由层） */
  antiAbusePaginationCap: true,
  /** 反滥用：nginx 防盗链（由部署配置控制，此 flag 仅作记录与开关位） */
  antiAbuseHotlinkGuard: true,
} as const;

export type FeatureFlagName = keyof typeof FEATURE_FLAGS;

/** 每个 flag 对应的环境变量名。 */
const ENV_KEYS: Record<FeatureFlagName, string> = {
  antiAbuseRateLimit: "FEATURE_ANTI_ABUSE_RATE_LIMIT",
  antiAbusePaginationCap: "FEATURE_ANTI_ABUSE_PAGINATION_CAP",
  antiAbuseHotlinkGuard: "FEATURE_ANTI_ABUSE_HOTLINK_GUARD",
};

function parseBool(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
}

/**
 * 判定一个 flag 是否开启。
 *
 * @param name flag 名
 * @param env 环境变量表（默认 process.env）。传参便于单测。
 */
export function isFeatureEnabled(
  name: FeatureFlagName,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const override = parseBool(env[ENV_KEYS[name]]);
  if (override !== null) return override;
  return FEATURE_FLAGS[name];
}

/** flag 的环境变量名（部署文档与运维排障要用）。 */
export function featureFlagEnvKey(name: FeatureFlagName): string {
  return ENV_KEYS[name];
}

/** 当前所有 flag 的状态快照（排障用）。 */
export function featureFlagSnapshot(
  env: Record<string, string | undefined> = process.env,
): Record<FeatureFlagName, boolean> {
  const out = {} as Record<FeatureFlagName, boolean>;
  for (const name of Object.keys(FEATURE_FLAGS) as FeatureFlagName[]) {
    out[name] = isFeatureEnabled(name, env);
  }
  return out;
}
