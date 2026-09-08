import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import SessionHallClient from "@/components/sessions/session-hall-client";

export const dynamic = "force-dynamic";

export default async function SessionsPage() {
  const session = await auth();

  const [live, upcoming, ended] = await Promise.all([
    prisma.teaSession.findMany({
      where: { status: "live" },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        host: { select: { id: true, username: true, avatar: true, level: true } },
        tea: { select: { name: true, year: true, type: true } },
        _count: { select: { messages: true, participants: true, invitations: true } },
      },
    }),
    prisma.teaSession.findMany({
      where: { status: "confirmed" },
      orderBy: { scheduledAt: "asc" },
      take: 50,
      include: {
        host: { select: { id: true, username: true, avatar: true, level: true } },
        tea: { select: { name: true, year: true, type: true } },
        _count: { select: { messages: true, participants: true, invitations: true } },
      },
    }),
    prisma.teaSession.findMany({
      where: { status: { in: ["ended", "expired", "cancelled"] } },
      orderBy: { endedAt: "desc" },
      take: 50,
      include: {
        host: { select: { id: true, username: true, avatar: true, level: true } },
        tea: { select: { name: true, year: true, type: true } },
        _count: { select: { messages: true, participants: true, invitations: true } },
      },
    }),
  ]);

  const serialize = (sessions: typeof live) =>
    sessions.map((s) => ({
      id: s.id,
      title: s.title,
      teaName: s.teaName,
      coverImage: s.coverImage,
      status: s.status,
      viewerCount: s.viewerCount,
      peakParticipants: s.peakParticipants,
      _count: { messages: s._count.messages },
      host: s.host,
      tea: s.tea,
      scheduledAt: s.scheduledAt?.toISOString() ?? null,
      startedAt: s.startedAt?.toISOString() ?? null,
      endedAt: s.endedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    }));

  return (
    <div className="max-w-6xl mx-auto px-3 md:px-4 py-6">
      <SessionHallClient
        live={serialize(live)}
        upcoming={serialize(upcoming)}
        ended={serialize(ended)}
        currentUserId={session?.user?.id}
        userLevel={session?.user?.level ?? 0}
      />
    </div>
  );
}
