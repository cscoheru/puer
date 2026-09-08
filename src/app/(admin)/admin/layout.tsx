import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Providers from "@/components/layout/providers";
import Header from "@/components/layout/header";
import AdminSidebar from "@/components/admin/admin-sidebar";
import { cookies } from "next/headers";
import type { Locale } from "@/i18n/translations";
import "../../globals.css";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    redirect("/login");
  }

  const cookieStore = await cookies();
  const localeCookie = cookieStore.get("puer-locale")?.value as Locale | undefined;

  return (
    <Providers initialLocale={localeCookie}>
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
