"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import MessageDialog from "./message-dialog";

interface Props {
  targetId: string;
  targetName: string;
}

export default function MessageButton({ targetId, targetName }: Props) {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);

  // Don't show message button for own profile
  if (session?.user?.id === targetId) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs px-3 py-1.5 rounded-lg border border-stone-300 text-stone-600 hover:bg-stone-50 hover:border-stone-400 transition"
      >
        💬 留言
      </button>

      {open && (
        <MessageDialog
          receiverId={targetId}
          receiverName={targetName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
