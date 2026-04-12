/**
 * Cloudinary transform/CDN layer for platform-specific asset variants.
 *
 * Optional — if CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, or CLOUDINARY_API_SECRET
 * are missing, all exports gracefully degrade (return null / empty arrays).
 * Supabase Storage remains the primary artifact store; Cloudinary adds transform + CDN.
 */

import { v2 as cloudinary } from "cloudinary";
import type { PlatformSpec, PlatformVariant } from "./types.js";

// ============ Configuration ============

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (CLOUD_NAME && API_KEY && API_SECRET) {
  cloudinary.config({
    cloud_name: CLOUD_NAME,
    api_key: API_KEY,
    api_secret: API_SECRET,
    secure: true,
  });
}

/**
 * Check whether all three Cloudinary env vars are present.
 */
export function isCloudinaryConfigured(): boolean {
  return Boolean(CLOUD_NAME && API_KEY && API_SECRET);
}

// ============ Platform Specs ============

export const PLATFORM_SPECS: Record<string, PlatformSpec> = {
  ig_feed: {
    key: "ig_feed",
    label: "Instagram Feed",
    width: 1080,
    height: 1080,
    aspectRatio: "1:1",
    crop: "fill",
    gravity: "auto",
  },
  ig_story: {
    key: "ig_story",
    label: "Instagram Story",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    crop: "fill",
    gravity: "auto",
  },
  fb_feed: {
    key: "fb_feed",
    label: "Facebook Feed",
    width: 1200,
    height: 630,
    aspectRatio: "1.91:1",
    crop: "fill",
    gravity: "auto",
  },
  fb_story: {
    key: "fb_story",
    label: "Facebook Story",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    crop: "fill",
    gravity: "auto",
  },
  x_post: {
    key: "x_post",
    label: "X Post",
    width: 1200,
    height: 675,
    aspectRatio: "16:9",
    crop: "fill",
    gravity: "auto",
  },
  x_header: {
    key: "x_header",
    label: "X Header",
    width: 1500,
    height: 500,
    aspectRatio: "3:1",
    crop: "fill",
    gravity: "auto",
  },
  linkedin_post: {
    key: "linkedin_post",
    label: "LinkedIn Post",
    width: 1200,
    height: 627,
    aspectRatio: "1.91:1",
    crop: "fill",
    gravity: "auto",
  },
  pinterest_pin: {
    key: "pinterest_pin",
    label: "Pinterest Pin",
    width: 1000,
    height: 1500,
    aspectRatio: "2:3",
    crop: "fill",
    gravity: "auto",
  },
  tiktok_video: {
    key: "tiktok_video",
    label: "TikTok Video",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    crop: "fill",
    gravity: "auto",
  },
  youtube_thumb: {
    key: "youtube_thumb",
    label: "YouTube Thumbnail",
    width: 1280,
    height: 720,
    aspectRatio: "16:9",
    crop: "fill",
    gravity: "auto",
  },
};

// ============ Upload ============

/**
 * Upload a local file to Cloudinary.
 * Returns public ID + secure URL on success, null on failure or if not configured.
 */
export async function uploadToCloudinary(
  localPath: string,
  publicId: string,
): Promise<{ publicId: string; secureUrl: string } | null> {
  if (!isCloudinaryConfigured()) {
    return null;
  }

  try {
    const result = await cloudinary.uploader.upload(localPath, {
      public_id: publicId,
      resource_type: "auto",
      overwrite: true,
    });

    return {
      publicId: result.public_id,
      secureUrl: result.secure_url,
    };
  } catch (err) {
    console.warn("[cloudinary] Upload failed:", err);
    return null;
  }
}

// ============ Platform Variant URLs ============

/**
 * Build a single platform-transformed URL from a Cloudinary public ID.
 * Returns null if Cloudinary is not configured or the platform key is unknown.
 */
export function buildPlatformUrl(
  cloudinaryPublicId: string,
  platform: string,
): string | null {
  if (!isCloudinaryConfigured()) {
    return null;
  }

  const spec = PLATFORM_SPECS[platform];
  if (!spec) {
    return null;
  }

  return cloudinary.url(cloudinaryPublicId, {
    transformation: [
      {
        width: spec.width,
        height: spec.height,
        crop: spec.crop,
        gravity: spec.gravity,
        fetch_format: "auto",
        quality: "auto",
      },
    ],
    secure: true,
  });
}

/**
 * Build platform variant URLs for multiple platforms.
 * If `platforms` is provided, only those are returned; otherwise all 10 presets.
 */
export function getPlatformVariants(
  cloudinaryPublicId: string,
  platforms?: string[],
): PlatformVariant[] {
  if (!isCloudinaryConfigured()) {
    return [];
  }

  const keys = platforms && platforms.length > 0
    ? platforms.filter((p) => p in PLATFORM_SPECS)
    : Object.keys(PLATFORM_SPECS);

  const variants: PlatformVariant[] = [];

  for (const key of keys) {
    const spec = PLATFORM_SPECS[key];
    const url = buildPlatformUrl(cloudinaryPublicId, key);
    if (url && spec) {
      variants.push({
        platform: key,
        label: spec.label,
        width: spec.width,
        height: spec.height,
        aspectRatio: spec.aspectRatio,
        url,
      });
    }
  }

  return variants;
}
