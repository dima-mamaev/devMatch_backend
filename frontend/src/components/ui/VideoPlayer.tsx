"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { PlayIcon } from "@/components/icons";

interface VideoPlayerProps {
  url: string;
  thumbnail?: string | null;
  className?: string;
  aspectRatio?: "video" | "square" | "portrait";
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  controls?: boolean;
  onPlay?: () => void;
  onPause?: () => void;
  onEnded?: () => void;
}

const aspectRatioClasses = {
  video: "aspect-video",
  square: "aspect-square",
  portrait: "aspect-9/16",
};

export function VideoPlayer({
  url,
  thumbnail,
  className = "",
  aspectRatio = "video",
  autoPlay = false,
  muted = false,
  loop = false,
  controls = true,
  onPlay,
  onPause,
  onEnded,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const [showThumbnail, setShowThumbnail] = useState(!!thumbnail && !autoPlay);

  const handleTogglePlay = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        setShowThumbnail(false);
        setIsPlaying(true);
        videoRef.current.play().then(() => {
        }).catch((err) => {
          setIsPlaying(false);
        });
      }
    }
  }, [isPlaying]);

  const handleVideoPlay = useCallback(() => {
    setIsPlaying(true);
    setShowThumbnail(false);
    onPlay?.();
  }, [onPlay]);

  const handleVideoPause = useCallback(() => {
    setIsPlaying(false);
    onPause?.();
  }, [onPause]);

  const handleVideoEnded = useCallback(() => {
    setIsPlaying(false);
    if (thumbnail && !loop) {
      setShowThumbnail(true);
    }
    onEnded?.();
  }, [thumbnail, loop, onEnded]);

  const prevAutoPlayRef = useRef(autoPlay);
  useEffect(() => {
    if (videoRef.current && prevAutoPlayRef.current !== autoPlay) {
      prevAutoPlayRef.current = autoPlay;
      if (autoPlay) {
        videoRef.current.play().catch(() => {
        });
      } else {
        videoRef.current.pause();
      }
    }
  }, [autoPlay]);

  const aspectClass = aspectRatioClasses[aspectRatio];

  return (
    <div className={`relative overflow-hidden touch-pan-y ${aspectClass} ${className}`}>
      <video
        ref={videoRef}
        src={url}
        className="absolute inset-0 w-full h-full object-cover touch-pan-y"
        controls={controls && !showThumbnail}
        autoPlay={autoPlay}
        muted={muted || autoPlay}
        loop={loop}
        playsInline
        onPlay={handleVideoPlay}
        onPause={handleVideoPause}
        onEnded={handleVideoEnded}
      />
      {showThumbnail && thumbnail && (
        <div className="absolute inset-0 pointer-events-none">
          <img
            src={thumbnail}
            alt="Video thumbnail"
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-linear-to-b from-black/10 via-transparent to-black/30" />
        </div>
      )}
      {!isPlaying && (
        <div
          className="absolute inset-0 flex items-center justify-center cursor-pointer"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleTogglePlay();
          }}
        >
          <div className="w-16 h-16 bg-white/20 border border-white/30 rounded-full flex items-center justify-center hover:bg-white/30 transition-colors">
            <PlayIcon className="w-6 h-6 text-white ml-1" />
          </div>
        </div>
      )}
    </div>
  );
}
