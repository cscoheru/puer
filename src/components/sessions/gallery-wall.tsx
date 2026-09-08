"use client";

import { useState, useEffect } from "react";
import { Socket } from "socket.io-client";
import { WS_EVENTS } from "@/lib/session-constants";

interface GalleryEntry {
  id: string;
  steepNumber: number;
  imageUrl: string;
  description: string | null;
  createdAt: string;
}

interface Props {
  socket: Socket | null;
  initialGallery: GalleryEntry[];
}

export default function GalleryWall({ socket, initialGallery }: Props) {
  const [gallery, setGallery] = useState<GalleryEntry[]>(initialGallery);
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    if (!socket) return;

    const handler = (data: GalleryEntry & { type: string }) => {
      if (data.imageUrl) {
        setGallery((prev) => {
          if (prev.some((g) => g.id === data.id)) return prev;
          return [...prev, data];
        });
      }
    };

    socket.on(WS_EVENTS.BREW_UPDATED, handler);
    return () => {
      socket.off(WS_EVENTS.BREW_UPDATED, handler);
    };
  }, [socket]);

  const withImage = gallery.filter((g) => g.imageUrl);

  if (withImage.length === 0) {
    return (
      <div className="text-center py-8 text-stone-400 text-sm">
        <div className="text-3xl mb-2">📷</div>
        还没有茶汤照片
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-2">
        {withImage.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setLightbox(entry.imageUrl)}
            className="aspect-square rounded-lg overflow-hidden relative group"
          >
            <img
              src={entry.imageUrl}
              alt={entry.description ?? `第${entry.steepNumber}泡`}
              className="w-full h-full object-cover hover:scale-105 transition-transform"
            />
            <span className="absolute bottom-1 left-1 text-xs bg-black/50 text-white px-1.5 py-0.5 rounded">
              #{entry.steepNumber}
            </span>
          </button>
        ))}
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox}
            alt=""
            className="max-w-full max-h-full rounded-lg"
          />
        </div>
      )}
    </>
  );
}
