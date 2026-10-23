"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import { I18nProvider } from "@/i18n/context";
import type { Locale } from "@/i18n/translations";
import { usePresenceSocket } from "@/lib/presence-socket";
import InvitationNotification from "@/components/sessions/invitation-notification";
import { FeatureProvider, type FeatureState } from "@/components/layout/feature-context";

/** Establishes the user-level presence socket connection */
function PresenceInit() {
  usePresenceSocket();
  return null;
}

export default function Providers({
  children,
  initialLocale,
  session,
  features = {},
}: {
  children: React.ReactNode;
  initialLocale?: string;
  session?: Session | null;
  /** 服务端算好的 feature flag 快照。 */
  features?: FeatureState;
}) {
  return (
    <SessionProvider session={session}>
      <I18nProvider initialLocale={initialLocale as Locale | undefined}>
        <FeatureProvider features={features}>
          <PresenceInit />
          <InvitationNotification />
          {children}
        </FeatureProvider>
      </I18nProvider>
    </SessionProvider>
  );
}
