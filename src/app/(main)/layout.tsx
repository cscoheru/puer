import Providers from "@/components/layout/providers";
import Header from "@/components/layout/header";
import { cookies, headers } from "next/headers";
import { auth } from "@/lib/auth";
import { pickLocale } from "@/i18n/translations";
import "../globals.css";

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  // Validated, not merely cast: the cookie is attacker-controllable and any
  // string is expressible in it. See `parseLocale` / `pickLocale`.
  const localeCookie = cookieStore.get("puer-locale")?.value;
  // src/proxy.ts stamps this from the pathname, so on /tw/... pages it is the
  // URL's opinion and outranks the cookie. I18nProvider reaches the same verdict
  // client-side via usePathname(); passing it here as well means the server sends
  // HTML that is already in the right language, instead of correct markup only
  // after hydration (a visible flash, and a CLS risk).
  //
  // Note the URL's opinion is a *force*, not a general vote — outside /tw the
  // header reads "zh-CN", and honoring that would outrank a reader's deliberate
  // zh-TW cookie on every simplified URL. That asymmetry lives on `pickLocale`
  // so it cannot be re-learned the hard way here.
  // `?? undefined`, not the bare `??`: pickLocale returns null when neither
  // source is usable, and Providers' prop is `string | undefined` — null is not
  // "absent".
  const initialLocale =
    pickLocale(headerList.get("x-puer-locale"), localeCookie) ?? undefined;
  // 服务端直接取 session 注入 SessionProvider:客户端 useSession() 立即拿到值,
  // 不再依赖 hydrate 后 fetch /api/auth/session(此前登录态要等资源加载完才显示)。
  const session = await auth();

  return (
    <Providers initialLocale={initialLocale} session={session}>
      <Header />
      <main className="flex-1">{children}</main>
    </Providers>
  );
}
