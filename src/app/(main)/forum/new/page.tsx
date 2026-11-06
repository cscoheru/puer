import { auth } from "@/lib/auth";
import { canUseAiCompose } from "@/lib/ai-compose";
import NewThreadClient from "./new-thread-client";

/**
 * 发布新帖（服务端入口）。
 *
 * 这个文件以前是 `"use client"` 的整页组件。为了把「AI 创作」只发给站长与
 * admin，需要在这里算权限 —— 站长白名单来自服务端 env（EDITOR_AUTHOR_UIDS），
 * 客户端读不到；在客户端抄一份白名单就是 R28 说的「各抄一份，早晚漂移」。
 *
 * 表单本身全在 ./new-thread-client.tsx，逻辑未改，只多一个 canUseAI。
 * 无权用户收到的 HTML 里**没有**这个按钮；接口侧还有一次独立判定
 * （src/app/api/ai/compose/route.ts），藏按钮不等于关权限。
 */
export default async function NewThreadPage() {
  const session = await auth();
  const canUseAI = canUseAiCompose(session?.user);
  return <NewThreadClient canUseAI={canUseAI} />;
}
