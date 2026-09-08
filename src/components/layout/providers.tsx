"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import { I18nProvider } from "@/i18n/context";
import type { Locale } from "@/i18n/translations";
import { usePresenceSocket } from "@/lib/presence-socket";
import InvitationNotification from "@/components/sessions/invitation-notification";

/** Establishes the user-level presence socket connection */
function PresenceInit() {
  usePresenceSocket();
  return null;
}

export default function Providers({
  children,
  initialLocale,
  session,
}: {
  children: React.ReactNode;
  initialLocale?: string;
  session?: Session | null;
}) {
  return (
    <SessionProvider session={session}>
      <I18nProvider initialLocale={initialLocale as Locale | undefined}>
        <PresenceInit />
        <InvitationNotification />
        {children}
      </I18nProvider>
    </SessionProvider>
  );
}
