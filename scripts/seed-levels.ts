import { PrismaClient } from "../src/generated/prisma";

const prisma = new PrismaClient();

const levels = [
  { level: 0, name: "茶客", expRequired: 0, daysRequired: 0, postsRequired: 0, commentsLikedRequired: 0 },
  { level: 1, name: "茶友", expRequired: 10, daysRequired: 7, postsRequired: 1, commentsLikedRequired: 0 },
  { level: 2, name: "茶人", expRequired: 100, daysRequired: 37, postsRequired: 5, commentsLikedRequired: 10 },
  { level: 3, name: "茶师", expRequired: 300, daysRequired: 127, postsRequired: 15, commentsLikedRequired: 50 },
  { level: 4, name: "茶宗", expRequired: 800, daysRequired: 307, postsRequired: 30, commentsLikedRequired: 200 },
];

async function main() {
  for (const l of levels) {
    await prisma.levelConfig.upsert({
      where: { level: l.level },
      update: l,
      create: l,
    });
    console.log(`Seeded level ${l.level}: ${l.name}`);
  }
  console.log("Done!");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
