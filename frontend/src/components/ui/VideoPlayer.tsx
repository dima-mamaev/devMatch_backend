"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { PlayIcon, PauseIcon, VolumeIcon, VolumeMuteIcon } from "@/components/icons";

interface VideoPlayerProps {
  url: string;
  thumbnail?: string | null;
  className?: string;
  aspectRatio?: "video" | "square" | "portrait";
  autoPlay?: boolean;
  defaultMuted?: boolean;
  loop?: boolean;
  controls?: boolean;
  showMuteButton?: boolean;
  showPlayButton?: boolean;
  isActive?: boolean;
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
  defaultMuted = false,
  loop = false,
  controls = true,
  showMuteButton = true,
  showPlayButton = true,
  isActive = true,
  onPlay,
  onPause,
  onEnded,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const [isMuted, setIsMuted] = useState(defaultMuted);
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
        }).catch(() => {
          setIsPlaying(false);
        });
      }
    }
  }, [isPlaying]);

  const handleToggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

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

  // Pause video when slide becomes inactive
  useEffect(() => {
    if (!isActive && videoRef.current && isPlaying) {
      videoRef.current.pause();
    }
  }, [isActive, isPlaying]);

  const aspectClass = aspectRatioClasses[aspectRatio];

  return (
    <div className={`relative overflow-hidden touch-pan-y ${aspectClass} ${className}`}>
      <video
        ref={videoRef}
        src={url}
        className="absolute inset-0 w-full h-full object-cover touch-pan-y"
        controls={controls && !showThumbnail}
        autoPlay={autoPlay}
        muted={isMuted}
        loop={loop}
        playsInline
        onPlay={handleVideoPlay}
        onPause={handleVideoPause}
        onEnded={handleVideoEnded}
      />
      {showMuteButton && (
        <button
          onClick={handleToggleMute}
          className="absolute top-4 right-4 z-10 w-8 h-8 bg-black/30 rounded-full flex items-center justify-center hover:bg-black/40 transition-colors"
        >
          {isMuted ? (
            <VolumeMuteIcon className="w-3.5 h-3.5 text-white" />
          ) : (
            <VolumeIcon className="w-3.5 h-3.5 text-white" />
          )}
        </button>
      )}
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
      {showPlayButton && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <button
            className={`pointer-events-auto swiper-no-swiping w-16 h-16 border border-white/30 rounded-full flex items-center justify-center transition-all ${
              isPlaying
                ? "bg-black/20 opacity-0 hover:opacity-100"
                : "bg-white/20 hover:bg-white/30"
            }`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleTogglePlay();
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            onTouchStart={(e) => {
              e.stopPropagation();
            }}
          >
            {isPlaying ? (
              <PauseIcon className="w-6 h-6 text-white" />
            ) : (
              <PlayIcon className="w-6 h-6 text-white ml-1" />
            )}
          </button>
        </div>
      )}
    </div>
  );
}
