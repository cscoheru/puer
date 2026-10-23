import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Providers from "@/components/layout/providers";
import Header from "@/components/layout/header";
import AdminSidebar from "@/components/admin/admin-sidebar";
import { cookies } from "next/headers";
import type { Locale } from "@/i18n/translations";
import "../../globals.css";
import { can } from "@/lib/permissions";
import { featureFlagSnapshot } from "@/lib/feature-flags";
import { cellarVisibleTo } from "@/lib/cellar-guard";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user || !can(session.user, "admin:access")) {
    redirect("/login");
  }

  const cookieStore = await cookies();
  const localeCookie = cookieStore.get("puer-locale")?.value as Locale | undefined;

  // 茶仓的可见性按人算（与前台布局同一套判定）—— 后台页也渲染 <Header />，
  // 两处口径必须一致，否则导航会在后台消失、在前台出现。
  const features = {
    ...featureFlagSnapshot(),
    cellar: cellarVisibleTo(session?.user),
  };

  return (
    <Providers initialLocale={localeCookie} features={features}>
      <Header />
      <div className="flex min-h-[calc(100vh-64px)]">
        <AdminSidebar />
        <main className="flex-1 p-6 max-w-7xl mx-auto w-full overflow-x-auto">
          {children}
        </main>
      </div>
    </Providers>
  );
}
