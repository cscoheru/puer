import { PrismaClient } from "../src/generated/prisma";

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    where: { uid: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, username: true, createdAt: true },
  });

  if (users.length === 0) {
    console.log("All users already have UIDs.");
    return;
  }

  const maxResult = await prisma.user.aggregate({ _max: { uid: true } });
  let nextUid = Math.max((maxResult._max.uid ?? 1000) + 1, 1001);

  console.log(`Found ${users.length} users without UID. Starting from ${nextUid}.`);

  for (const user of users) {
    if (nextUid > 9999) {
      console.error("UID range exhausted!");
      break;
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { uid: nextUid },
    });
    console.log(`${user.username} → ${nextUid}`);
    nextUid++;
  }

  console.log("Done!");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
