import { auth } from "@/lib/auth";
import { notFound } from "next/navigation";
import NewTastingForm from "./NewTastingForm";
import { can } from "@/lib/permissions";

export const dynamic = "force-dynamic";

// Admin-only: non-admins get 404 (consistent with /tasting list & detail pages).
export default async function NewTastingPage() {
  const session = await auth();
  if (!can(session?.user, "admin:access")) notFound();
  return <NewTastingForm />;
}
