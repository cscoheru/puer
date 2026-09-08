import { handlers } from "@/lib/auth";

export const { POST } = handlers;

// 给 session endpoint 强制 no-store:浏览器默认会对无缓存头的 JSON 启发式缓存,
// 导致登录后 useSession() 仍拿到缓存的 null(未登录),登录态延迟 ~1 分钟才生效。
export async function GET(...args: Parameters<typeof handlers.GET>) {
  const res = await handlers.GET(...args);
  res.headers.set("Cache-Control", "no-store, max-age=0, must-revalidate");
  return res;
}
