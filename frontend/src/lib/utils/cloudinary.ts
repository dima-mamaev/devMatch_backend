/**
 * Derives a thumbnail URL from a Cloudinary video URL.
 * Cloudinary automatically generates thumbnails by changing the video extension to .jpg
 */
export function getVideoThumbnailUrl(videoUrl: string | null | undefined): string | null {
  if (!videoUrl) return null;
  const lastDotIndex = videoUrl.lastIndexOf('.');
  if (lastDotIndex === -1) return null;
  return videoUrl.slice(0, lastDotIndex) + '.jpg';
}
