/**
 * IP → 省份/地区。
 *
 * ## 为什么需要它
 *
 * `users.registrationRegion`（注册地）这一列**从来没被写过** —— 注册接口
 * 只记了 `registrationIp`。于是密码找回的核验题「你注册时所在的省份是？」
 * 永远只能判「无法核对」：站长看到的申请单里没有任何能证明「人在哪」的
 * 信息。
 *
 * 站长 2026-10-24：「用户注册时系统日志里没有注册地记录？不是有IP地址吗？」
 * —— 对，**有 IP**。那就从 IP 反查。
 *
 * ## 为什么不在注册那一刻就查
 *
 * 注册路径不能被第三方服务拖慢（更不能被它拖挂）。所以改成**懒查**：
 * 站长打开「密码重置申请」列表时才解析，解析结果按 IP 缓存一小时。
 * 解析不了就显示原始 IP —— **IP 本身就是证据**，省份只是锦上添花。
 *
 * ## 隐私
 *
 * 反查会把用户的 IP 交给第三方（ip-api.com）。隐私政策里已写明这一条。
 * 站点本来就只把 IP 用于安全防护与故障排查，这属于同一用途的延伸。
 */

/** 反查服务的地址。可用环境变量 `IP_REGION_API` 换成自建/别的服务。 */
const DEFAULT_API = "http://ip-api.com/json";

/** 单次查询的超时。查不到就当没有 —— 绝不因此拖住后台页面。 */
const TIMEOUT_MS = 1500;

/** 缓存有效期。同一批申请里同一个 IP 只查一次。 */
const CACHE_TTL_MS = 60 * 60 * 1000;

type CacheEntry = { region: string | null; at: number };

const cache = new Map<string, CacheEntry>();

/**
 * 私网 / 保留地址 —— 解析了也没意义（拿不到省份），直接跳过。
 *
 * 服务器在本机跑测试、或走本地反代时拿到的就是这类地址。
 */
export function isPublicIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const s = ip.trim().toLowerCase();
  if (!s || s === "unknown" || s === "::1" || s === "localhost") return false;
  if (s.startsWith("127.")) return false;
  if (s === "0.0.0.0") return false;
  if (s.startsWith("10.") || s.startsWith("192.168.")) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return false;
  if (/^169\.254\./.test(s)) return false;
  if (s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80")) return false;
  return true;
}

/**
 * 从服务商的返回里抠出「省」这一层。
 *
 * ip-api 的返回形如：
 * `{"status":"success","country":"中国","region":"SD","regionName":"山东",…}`
 * 境外地址 `regionName` 是英文地名（"California"），也照样显示 ——
 * 站长看得懂就行。
 */
export function parseRegionResponse(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { status?: string; regionName?: string; region?: string; country?: string; countryCode?: string };
  if (obj.status && obj.status !== "success") return null;
  const region = (obj.regionName || obj.region || "").trim();
  const country = (obj.country || "").trim();
  if (!region) return null;
  // 中国境内的地址 province 本身就是「山东/广东」这种地名，不必再拼国家
  if (!country || obj.countryCode === "CN" || country === "中国") return region;
  return `${country} · ${region}`;
}

/**
 * 查一个 IP 属于哪个省。查不到返回 null（**不抛异常** —— 反查是锦上添花，
 * 绝不能因为它把整个后台页面带崩）。
 */
export async function resolveIpRegion(
  ip: string | null | undefined,
): Promise<string | null> {
  if (!isPublicIp(ip)) return null;
  const key = ip!.trim();

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.region;

  let region: string | null = null;
  try {
    const base = process.env.IP_REGION_API || DEFAULT_API;
    const res = await fetch(`${base}/${encodeURIComponent(key)}?lang=zh-CN&fields=status,regionName,region,country,countryCode`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      region = parseRegionResponse(await res.json());
    }
  } catch {
    // 网络不通 / 超时 / 返回不是 JSON —— 一律当作「查不到」
    region = null;
  }

  cache.set(key, { region, at: Date.now() });
  return region;
}
