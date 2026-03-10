"use client";

import { VideoPlayer } from "@/components/ui/VideoPlayer";
import { MapPinIcon, BriefcaseIcon } from "@/components/icons";
import { formatSeniorityLevel } from "@/lib/utils/developer";

interface Developer {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle?: string | null;
  location?: string | null;
  seniorityLevel?: string | null;
  techStack: string[];
  introVideo?: { url: string } | null;
  introVideoThumbnail?: { url: string } | null;
}

interface FeedSlideCardProps {
  developer: Developer;
  isActive: boolean;
}

export function FeedSlideCard({ developer, isActive }: FeedSlideCardProps) {
  const experienceText = developer.seniorityLevel
    ? formatSeniorityLevel(developer.seniorityLevel)
    : null;
  console.log(developer);

  return (
    <div className={`relative w-full h-full rounded-2xl overflow-hidden shadow-xl border border-slate-200 bg-slate-900 touch-pan-y transition-opacity duration-300 ${isActive ? "opacity-100" : "opacity-90"}`}>
      {developer.introVideo?.url && (
        <VideoPlayer
          key={developer.id}
          url={developer.introVideo.url}
          thumbnail={developer.introVideoThumbnail?.url}
          className="w-full h-full"
          aspectRatio="portrait"
          loop
          controls={false}
          showMuteButton
          isActive={isActive}
        />
      )}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "linear-gradient(rgba(0,0,0,0.1) 0%, transparent 30%, transparent 60%, rgba(0,0,0,0.75) 100%)",
        }}
      />
      <div className="absolute bottom-0 left-0 right-0 p-5">
        <h2 className="text-lg font-bold text-white">
          {developer.firstName} {developer.lastName}
        </h2>
        <p className="text-sm text-white/80 mt-0.5">
          {developer.jobTitle || "Developer"}
        </p>
        <div className="flex items-center gap-2 mt-2 text-xs text-white/70">
          {developer.location && (
            <div className="flex items-center gap-1">
              <MapPinIcon className="w-3 h-3" />
              <span>{developer.location}</span>
            </div>
          )}
          {developer.location && experienceText && (
            <span className="opacity-60">·</span>
          )}
          {experienceText && (
            <div className="flex items-center gap-1">
              <BriefcaseIcon className="w-3 h-3" />
              <span>{experienceText}</span>
            </div>
          )}
        </div>
        {developer.techStack.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {developer.techStack.slice(0, 3).map((tech) => (
              <span
                key={tech}
                className="px-2 py-0.5 bg-white/20 rounded-lg text-xs text-white"
              >
                {tech}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
