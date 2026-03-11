import { VideoPlayer } from "./VideoPlayer";
import { getVideoThumbnailUrl } from "@/lib/utils/cloudinary";

interface IntroVideoCardProps {
  videoUrl?: string | null;
  processingStatus?: string | null;
}

export function IntroVideoCard({
  videoUrl,
  processingStatus,
}: IntroVideoCardProps) {
  if (videoUrl && processingStatus === "Ready") {
    return (
      <div className="flex justify-center">
        <VideoPlayer
          url={videoUrl}
          thumbnail={getVideoThumbnailUrl(videoUrl)}
          aspectRatio="portrait"
          className="bg-slate-900 border border-slate-200 rounded-2xl shadow-lg h-125"
        />
      </div>
    );
  }

  return (
    <div className="bg-slate-900 border border-slate-200 rounded-2xl shadow-sm aspect-video relative overflow-hidden">
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 bg-white/10 rounded-full flex items-center justify-center mx-auto mb-3">
            <div className="w-6 h-6 border-2 border-white/30 border-t-white/70 rounded-full animate-spin" />
          </div>
          <p className="text-sm text-white/50">Processing video...</p>
        </div>
      </div>
    </div>
  );
}
