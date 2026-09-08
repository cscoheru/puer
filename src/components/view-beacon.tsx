"use client";

import { useEffect } from "react";

interface Props {
  articleId: string;
}

// Fire-once view ping on mount. JS-less crawlers never execute this, which is
// the primary bot filter; the /api/views endpoint additionally dedups per
// (article, visitor, day) and excludes admin/author. Renders nothing.
export default function ViewBeacon({ articleId }: Props) {
  useEffect(() => {
    fetch("/api/views", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articleId }),
      keepalive: true,
    }).catch(() => {});
  }, [articleId]);
  return null;
}
