"use client";

import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import { Swiper, SwiperSlide } from "swiper/react";
import { EffectCards, Keyboard } from "swiper/modules";
import type { Swiper as SwiperType } from "swiper";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { FeedSlideCard } from "@/components/ui/FeedSlideCard";
import { ActionButton } from "@/components/ui/ActionButton";
import { ActionLink } from "@/components/ui/ActionLink";
import {
  BookmarkIcon,
  GithubIcon,
  LinkedinIcon,
  MailIcon,
  UserIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  PlayIcon,
} from "@/components/icons";
import { useGetDevelopersQuery } from "@/lib/graphql/generated";
import { useShortlist } from "@/hooks/useShortlist";
import { useDeveloperProfile } from "@/hooks/useUser";

import "swiper/css";
import "swiper/css/effect-cards";

export default function DashboardPage() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const swiperRef = useRef<SwiperType | null>(null);

  const currentDeveloperProfile = useDeveloperProfile();
  const { isInShortlist, toggleShortlist, isLoading: shortlistLoading } = useShortlist();

  const { data, loading } = useGetDevelopersQuery({
    variables: {
      paging: { page: 1, limit: 50 },
      filter: {
        excludeIds: currentDeveloperProfile?.id ? [currentDeveloperProfile.id] : undefined,
        hasIntroVideo: true,
      },
    },
  });

  const developers = data?.getDevelopers?.results ?? [];
  const totalCount = developers.length;
  const currentDeveloper = developers[currentIndex];

  const handlePrevious = useCallback(() => {
    swiperRef.current?.slidePrev();
  }, []);

  const handleNext = useCallback(() => {
    swiperRef.current?.slideNext();
  }, []);

  const handleSlideChange = useCallback((swiper: SwiperType) => {
    setCurrentIndex(swiper.activeIndex);
  }, []);

  return (
    <DashboardLayout>
      <div className="bg-white border-b border-slate-200 h-14 flex items-center justify-between px-6">
        <div>
          <h1 className="text-base font-bold text-slate-900">Developer Feed</h1>
          <p className="text-xs text-slate-400">
            {loading ? "Loading..." : `${currentIndex + 1} of ${totalCount} developers`}
          </p>
        </div>
        {totalCount > 0 && (
          <div className="flex items-center gap-1.5">
            {developers.map((_, i) => (
              <button
                key={i}
                onClick={() => swiperRef.current?.slideTo(i)}
                className={`rounded-full transition-all ${i === currentIndex
                  ? "w-5 h-1.5 bg-indigo-600"
                  : "w-1.5 h-1.5 bg-slate-300 hover:bg-slate-400"
                  }`}
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-center h-full bg-slate-50 p-2">
        {loading ? (
          <div className="w-8 h-8 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin" />
        ) : totalCount === 0 ? (
          <div className="text-center">
            <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <PlayIcon className="w-8 h-8 text-slate-400" />
            </div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">
              No video introductions yet
            </h2>
            <p className="text-sm text-slate-500 mb-4">
              Developers with video introductions will appear here.
            </p>
            <Link
              href="/dashboard/developers"
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 transition-colors"
            >
              Browse All Developers
            </Link>
          </div>
        ) : (
          <div className="flex items-center gap-5">
            <div className="flex flex-col items-center gap-8">
              <button
                onClick={handleNext}
                disabled={currentIndex === totalCount - 1}
                className="w-9 h-9 bg-white border border-slate-200 rounded-full flex items-center justify-center shadow-sm hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                <ChevronUpIcon className="w-4 h-4 text-slate-600" />
              </button>
              <div className="w-85 h-151">
                <Swiper
                  modules={[EffectCards, Keyboard]}
                  effect="cards"
                  direction="vertical"
                  grabCursor
                  keyboard={{ enabled: true }}
                  noSwiping
                  noSwipingClass="swiper-no-swiping"
                  onSwiper={(swiper) => {
                    swiperRef.current = swiper;
                  }}
                  onSlideChange={handleSlideChange}
                  cardsEffect={{
                    slideShadows: false,
                    perSlideOffset: 8,
                    perSlideRotate: 0,
                  }}
                  className="w-full h-full"
                >
                  {developers.map((developer, index) => (
                    <SwiperSlide key={developer.id} className="rounded-2xl">
                      <FeedSlideCard
                        developer={developer}
                        isActive={index === currentIndex}
                      />
                    </SwiperSlide>
                  ))}
                </Swiper>
              </div>
              <button
                onClick={handlePrevious}
                disabled={currentIndex === 0}
                className="w-9 h-9 bg-white border border-slate-200 rounded-full flex items-center justify-center shadow-sm hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                <ChevronDownIcon className="w-4 h-4 text-slate-600" />
              </button>
            </div>
            {currentDeveloper && (
              <div className="flex flex-col gap-5">
                <ActionButton
                  onClick={() => toggleShortlist(currentDeveloper.id)}
                  disabled={shortlistLoading}
                  active={isInShortlist(currentDeveloper.id)}
                  label="Save"
                  icon={<BookmarkIcon className="w-5 h-5" />}
                />
                {currentDeveloper.githubUrl && (
                  <ActionLink
                    href={currentDeveloper.githubUrl}
                    label="GitHub"
                    icon={<GithubIcon className="w-5 h-5" />}
                  />
                )}
                {currentDeveloper.linkedinUrl && (
                  <ActionLink
                    href={currentDeveloper.linkedinUrl}
                    label="LinkedIn"
                    icon={<LinkedinIcon className="w-5 h-5" />}
                  />
                )}
                <ActionLink
                  href={`mailto:contact@devmatch.io?subject=Interested in ${currentDeveloper.firstName}`}
                  label="Email"
                  icon={<MailIcon className="w-5 h-5" />}
                />
                <ActionLink
                  href={`/dashboard/developers/${currentDeveloper.id}`}
                  label="Profile"
                  icon={<UserIcon className="w-5 h-5" />}
                  internal
                />
              </div>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
