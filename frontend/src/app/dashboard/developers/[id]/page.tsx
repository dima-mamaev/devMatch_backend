"use client";

import { useParams, useRouter } from "next/navigation";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import {
  ArrowLeftIcon,
  MailIcon,
  BookmarkIcon,
} from "@/components/icons";
import { useGetDeveloperQuery } from "@/lib/graphql/generated";
import { useShortlist } from "@/hooks/useShortlist";

import { Button } from "@/components/ui/Button";
import { ProfileHeader } from "@/components/ui/ProfileHeader";
import { IntroVideoCard } from "@/components/ui/IntroVideoCard";
import { AboutCard } from "@/components/ui/AboutCard";
import { SkillsCard } from "@/components/ui/SkillsCard";
import { ExperienceCard } from "@/components/ui/ExperienceCard";
import { ProjectsCard } from "@/components/ui/ProjectsCard";
import { LinksCard } from "@/components/ui/LinksCard";
import { QuickStatsCard } from "@/components/ui/QuickStatsCard";

export default function DeveloperProfilePage() {
  const params = useParams();
  const router = useRouter();
  const developerId = params.id as string;

  const { data, loading, error } = useGetDeveloperQuery({
    variables: { id: developerId },
    skip: !developerId,
  });

  const {
    isInShortlist,
    toggleShortlist,
    isLoading: shortlistLoading,
  } = useShortlist();

  const developer = data?.getDeveloper;
  const isShortlisted = developer ? isInShortlist(developer.id) : false;

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="w-8 h-8 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin" />
        </div>
      </DashboardLayout>
    );
  }

  if (error || !developer) {
    return (
      <DashboardLayout>
        <div className="p-6 max-w-5xl mx-auto">
          <Button
            variant="ghost-muted"
            size="sm"
            onClick={() => router.back()}
            className="mb-6"
          >
            <ArrowLeftIcon className="w-4 h-4" />
            Back
          </Button>
          <div className="text-center py-16">
            <h2 className="text-lg font-semibold text-slate-900 mb-1">
              Developer not found
            </h2>
            <p className="text-sm text-slate-500">
              The developer profile you&apos;re looking for doesn&apos;t exist or has been removed.
            </p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="p-6 max-w-5xl mx-auto">
        <Button
          variant="ghost-muted"
          size="sm"
          onClick={() => router.back()}
          className="mb-6"
        >
          <ArrowLeftIcon className="w-4 h-4" />
          Back
        </Button>
        <div className="mb-5">
          <ProfileHeader
            firstName={developer.firstName}
            lastName={developer.lastName}
            jobTitle={developer.jobTitle}
            location={developer.location}
            seniorityLevel={developer.seniorityLevel}
            availabilityStatus={developer.availabilityStatus}
            profilePhotoUrl={developer.profilePhoto?.url}
          />
        </div>
        <div className="flex gap-5">
          <div className="flex-1 space-y-5">
            <IntroVideoCard
              videoUrl={developer.introVideo?.url}
              processingStatus={developer.introVideo?.processingStatus}
            />
            <AboutCard bio={developer.bio || ""} />
            <SkillsCard techStack={developer.techStack} />
            <ExperienceCard experiences={developer.experiences} />
            <ProjectsCard projects={developer.projects} />
          </div>
          <div className="w-67.5 shrink-0 space-y-4">
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
              <h3 className="text-sm font-bold text-slate-900 mb-4">Take action</h3>
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  href={`mailto:${developer.email}`}
                  className="w-full"
                >
                  <MailIcon className="w-4 h-4" />
                  Contact Developer
                </Button>
                <Button
                  variant={isShortlisted ? "success" : "primary"}
                  size="sm"
                  onClick={() => toggleShortlist(developer.id)}
                  disabled={shortlistLoading}
                  className="w-full"
                >
                  <BookmarkIcon className="w-4 h-4" />
                  {isShortlisted ? "Shortlisted" : "Shortlist"}
                </Button>
              </div>
            </div>
            <LinksCard
              githubUrl={developer.githubUrl}
              linkedinUrl={developer.linkedinUrl}
              personalSiteUrl={developer.personalSiteUrl}
            />
            <QuickStatsCard
              seniorityLevel={developer.seniorityLevel}
              projectsCount={developer.projects.length}
              techStackCount={developer.techStack.length}
              location={developer.location}
            />
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
