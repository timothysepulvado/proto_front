/**
 * Supabase Storage upload utility for artifacts.
 *
 * Storage path convention: {client_id}/{run_id}/{artifact_id}.{ext}
 * This mirrors the FK relationships in the artifacts table so you can
 * trace any file back to its client, run, and artifact row.
 */

import fs from "fs";
import path from "path";
import { supabase } from "./supabase.js";
import { isCloudinaryConfigured, uploadToCloudinary } from "./cloudinary.js";

const BUCKET = "artifacts";

/**
 * Derive MIME type from file extension.
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".gz": "application/gzip",
  };
  return mimeMap[ext] || "application/octet-stream";
}

/**
 * Get file size in bytes. Returns null if file doesn't exist.
 */
export function getFileSize(filePath: string): number | null {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch {
    return null;
  }
}

/**
 * Build the storage path for an artifact.
 * Convention: {client_id}/{run_id}/{artifact_id}{ext}
 */
export function buildStoragePath(
  clientId: string,
  runId: string,
  artifactId: string,
  fileName: string,
): string {
  const ext = path.extname(fileName);
  return `${clientId}/${runId}/${artifactId}${ext}`;
}

/**
 * Upload a local file to Supabase Storage and return the public URL.
 *
 * @returns { storagePath, publicUrl, size } on success, or null if upload fails.
 *          Failure is non-fatal — the caller should fall back to the local path.
 */
export async function uploadArtifact(
  clientId: string,
  runId: string,
  artifactId: string,
  localPath: string,
  fileName: string,
): Promise<{ storagePath: string; publicUrl: string; size: number | null; cloudinaryPublicId?: string } | null> {
  // Check file exists
  if (!fs.existsSync(localPath)) {
    console.warn(`[storage] File not found, skipping upload: ${localPath}`);
    return null;
  }

  const storagePath = buildStoragePath(clientId, runId, artifactId, fileName);
  const mimeType = getMimeType(localPath);
  const fileBuffer = fs.readFileSync(localPath);
  const size = getFileSize(localPath);

  try {
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, fileBuffer, {
        contentType: mimeType,
        upsert: true,  // Overwrite if re-run
      });

    if (uploadError) {
      console.error(`[storage] Upload failed for ${storagePath}:`, uploadError.message);
      return null;
    }

    // Get the public URL
    const { data: urlData } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(storagePath);

    // Dual-write to Cloudinary if configured (non-fatal)
    let cloudinaryPublicId: string | undefined;
    if (isCloudinaryConfigured()) {
      const cldPublicId = `brandstudios/${clientId}/${runId}/${artifactId}`;
      const cldResult = await uploadToCloudinary(localPath, cldPublicId);
      if (cldResult) {
        cloudinaryPublicId = cldResult.publicId;
      }
    }

    return {
      storagePath,
      publicUrl: urlData.publicUrl,
      size,
      cloudinaryPublicId,
    };
  } catch (err) {
    console.error(`[storage] Unexpected error uploading ${storagePath}:`, err);
    return null;
  }
}
