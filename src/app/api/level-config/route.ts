import { getLevelConfigs } from "@/lib/level-config";

export async function GET() {
  const configs = await getLevelConfigs();
  return Response.json({ levels: configs });
}
