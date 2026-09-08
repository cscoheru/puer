"use client";

import { useRef, useEffect, useState, useCallback } from "react";

interface VideoPlayerProps {
  src: string;
  className?: string;
  feed?: boolean;
  onVideoError?: () => void;
}

export default function VideoPlayer({ src, className = "", feed = false, onVideoError }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showPlayBtn, setShowPlayBtn] = useState(true);
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Lazy load: only set src when container is near viewport
  useEffect(() => {
    if (!mounted || !feed || shouldLoad) return;
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShouldLoad(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [mounted, feed, shouldLoad]);

  // Detail mode: IntersectionObserver autoplay
  useEffect(() => {
    if (!mounted || feed) return;
    const el = containerRef.current;
    const video = videoRef.current;
    if (!el || !video) return;

    const isX5 = /x5/i.test(navigator.userAgent);
    if (isX5) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            video.muted = true;
            video.play().catch(() => setPlaying(false));
          } else {
            video.pause();
          }
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [mounted, feed]);

  const handleFeedClick = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setShowPlayBtn(false);
    video.muted = true;
    video.play().catch(() => {});
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  if (error) return null;

  const videoSrc = feed && !shouldLoad ? undefined : src;

  return (
    <div
      ref={containerRef}
      className={`relative bg-black rounded-lg overflow-hidden ${feed ? "cursor-pointer" : ""} ${className}`}
      onClick={feed && showPlayBtn ? handleFeedClick : undefined}
    >
      <video
        ref={videoRef}
        src={videoSrc}
        preload={feed ? "none" : "metadata"}
        playsInline
        muted
        loop
        suppressHydrationWarning
        className={`w-full object-contain ${feed ? "max-h-[300px]" : "max-h-[500px]"}`}
        onPlaying={() => { setPlaying(true); setShowPlayBtn(false); }}
        onPause={() => setPlaying(false)}
        onError={() => { setError(true); onVideoError?.(); }}
      />

      {/* Feed: play button overlay until user clicks */}
      {feed && showPlayBtn && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-12 h-12 bg-black/40 rounded-full flex items-center justify-center">
            <svg width="20" height="22" viewBox="0 0 20 22" fill="white"><polygon points="2,0 20,11 2,22" /></svg>
          </div>
        </div>
      )}

      {/* Mute toggle */}
      {playing && !showPlayBtn && (
        <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/50 to-transparent pointer-events-none">
          <button type="button" onClick={toggleMute}
            className="w-8 h-8 bg-black/50 hover:bg-black/70 rounded-full text-white text-xs flex items-center justify-center transition pointer-events-auto"
            aria-label={muted ? "取消静音" : "静音"}
          >
            {muted ? "🔇" : "🔊"}
          </button>
        </div>
      )}
    </div>
  );
}
