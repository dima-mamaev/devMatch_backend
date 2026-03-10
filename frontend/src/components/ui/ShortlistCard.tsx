"use client";

import {
  GithubIcon,
  LinkedinIcon,
  MailIcon,
  UserIcon,
  TrashIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";

interface Developer {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle?: string | null;
  location?: string | null;
  seniorityLevel?: string | null;
  techStack: string[];
  githubUrl?: string | null;
  linkedinUrl?: string | null;
  email?: string | null;
  bio?: string | null;
  profilePhoto?: { url: string } | null;
}

interface ShortlistCardProps {
  developer: Developer;
  onRemove: (developerId: string) => void;
  isLoading?: boolean;
}

const SENIORITY_YEARS: Record<string, string> = {
  Junior: "0-2 yrs",
  Mid: "2-4 yrs",
  Senior: "4-8 yrs",
  Lead: "8-12 yrs",
  Principal: "12+ yrs",
};

export function ShortlistCard({
  developer,
  onRemove,
  isLoading = false,
}: ShortlistCardProps) {
  const fullName = `${developer.firstName} ${developer.lastName}`.trim();
  const initials =
    `${developer.firstName?.[0] || ""}${developer.lastName?.[0] || ""}`.toUpperCase() || "?";

  const experienceText = developer.seniorityLevel
    ? SENIORITY_YEARS[developer.seniorityLevel] || developer.seniorityLevel
    : null;

  const locationExperience = [developer.location, experienceText ? `${experienceText} experience` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
      <div className="flex gap-4">
        <div className="shrink-0">
          {developer.profilePhoto?.url ? (
            <img
              src={developer.profilePhoto.url}
              alt={fullName}
              className="w-14 h-14 rounded-full object-cover border-2 border-slate-100"
            />
          ) : (
            <div className="w-14 h-14 rounded-full bg-indigo-500 flex items-center justify-center border-2 border-slate-100">
              <span className="text-lg font-bold text-white">{initials}</span>
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-bold text-slate-900">{fullName}</h3>
          <p className="text-sm text-slate-500 mt-0.5">
            {developer.jobTitle || "Developer"}
          </p>
          {locationExperience && (
            <p className="text-xs text-slate-400 mt-0.5">{locationExperience}</p>
          )}
          {developer.techStack.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {developer.techStack.slice(0, 5).map((tech) => (
                <span
                  key={tech}
                  className="px-2 py-0.5 bg-slate-100 border border-slate-200 rounded-lg text-xs font-medium text-slate-600"
                >
                  {tech}
                </span>
              ))}
              {developer.techStack.length > 5 && (
                <span className="px-2 py-0.5 text-xs text-slate-400">
                  +{developer.techStack.length - 5}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="shrink-0 flex flex-col gap-2">
          <div className="flex gap-2">
            {developer.githubUrl && (
              <Button variant="outline-muted" size="xs" href={developer.githubUrl}>
                <GithubIcon className="w-3 h-3" />
                GitHub
              </Button>
            )}
            {developer.linkedinUrl && (
              <Button variant="outline-muted" size="xs" href={developer.linkedinUrl}>
                <LinkedinIcon className="w-3 h-3" />
                LinkedIn
              </Button>
            )}
            {developer.email && (
              <Button variant="outline-muted" size="xs" href={`mailto:${developer.email}`}>
                <MailIcon className="w-3 h-3" />
                Email
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="xs"
              href={`/dashboard/developers/${developer.id}`}
              className="flex-1"
            >
              <UserIcon className="w-3 h-3" />
              Profile
            </Button>
            <Button
              variant="danger"
              size="xs"
              onClick={() => onRemove(developer.id)}
              disabled={isLoading}
            >
              <TrashIcon className="w-3 h-3" />
              Remove
            </Button>
          </div>
        </div>
      </div>
      {developer.bio && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">
            {developer.bio}
          </p>
        </div>
      )}
    </div>
  );
}
