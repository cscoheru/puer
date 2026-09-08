import Providers from "@/components/layout/providers";
import Header from "@/components/layout/header";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import type { Locale } from "@/i18n/translations";
import "../globals.css";

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const localeCookie = cookieStore.get("puer-locale")?.value as Locale | undefined;
  // 服务端直接取 session 注入 SessionProvider:客户端 useSession() 立即拿到值,
  // 不再依赖 hydrate 后 fetch /api/auth/session(此前登录态要等资源加载完才显示)。
  const session = await auth();

  return (
    <Providers initialLocale={localeCookie} session={session}>
      <Header />
      <main className="flex-1">{children}</main>
    </Providers>
  );
}
