import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import SessionRoomClient from "@/components/sessions/session-room-client";

export const dynamic = "force-dynamic";

export default async function SessionRoomPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const user = await auth();

  const session = await prisma.teaSession.findUnique({
    where: { id },
    include: {
      host: { select: { id: true, username: true, avatar: true, level: true } },
      tea: { select: { id: true, name: true, brand: true, year: true, type: true } },
      invitations: {
        include: {
          inviter: { select: { id: true, username: true, avatar: true, level: true, onlineStatus: true } },
          invitee: { select: { id: true, username: true, avatar: true, level: true, onlineStatus: true } },
        },
        orderBy: { createdAt: "desc" },
      },
      _count: { select: { messages: true, participants: true, invitations: true } },
    },
  });

  if (!session) notFound();

  const messages = await prisma.teaSessionMessage.findMany({
    where: { sessionId: id },
    orderBy: { createdAt: "asc" },
    take: 100,
    include: {
      user: { select: { id: true, username: true, avatar: true, level: true } },
    },
  });

  const gallery = await prisma.teaSessionGallery.findMany({
    where: { sessionId: id },
    orderBy: { steepNumber: "asc" },
  });

  const participantCount = await prisma.sessionParticipant.count({
    where: { sessionId: id, leftAt: null },
  });

  return (
    <div className="max-w-6xl mx-auto px-3 md:px-4 py-4">
      <SessionRoomClient
        session={{
          id: session.id,
          title: session.title,
          teaName: session.teaName,
          description: session.description,
          coverImage: session.coverImage,
          images: session.images,
          brewMethod: session.brewMethod,
          waterTemp: session.waterTemp,
          teaWeight: session.teaWeight,
          status: session.status,
          steepCount: session.steepCount,
          viewerCount: session.viewerCount,
          peakParticipants: session.peakParticipants,
          teaGiftsCount: session.teaGiftsCount,
          hostId: session.hostId,
          duration: session.duration,
          publishedArticleId: session.publishedArticleId,
          scheduledAt: session.scheduledAt?.toISOString() ?? null,
          startedAt: session.startedAt?.toISOString() ?? null,
          endedAt: session.endedAt?.toISOString() ?? null,
          createdAt: session.createdAt.toISOString(),
          host: session.host,
          tea: session.tea,
          _count: session._count,
          invitations: session.invitations.map((inv) => ({
            id: inv.id,
            status: inv.status,
            inviter: inv.inviter,
            invitee: inv.invitee,
            createdAt: inv.createdAt.toISOString(),
            respondedAt: inv.respondedAt?.toISOString() ?? null,
          })),
          participantCount,
        }}
        initialMessages={messages.map((m) => ({
          ...m,
          createdAt: m.createdAt.toISOString(),
        }))}
        initialGallery={gallery.map((g) => ({
          ...g,
          createdAt: g.createdAt.toISOString(),
        }))}
        currentUser={user?.user ?? null}
      />
    </div>
  );
}
