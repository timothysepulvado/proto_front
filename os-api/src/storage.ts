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

/**
 * Mint a time-limited signed URL for a Storage object in the artifacts bucket.
 *
 * The signed URL respects bucket-level + object-level RLS at fetch time. When
 * the bucket is private (post PR #5 Migration 018), the signed URL is the only
 * way to read the bytes; when the bucket is public, signed URLs continue to
 * work alongside the public URL pattern.
 *
 * @param storagePath in-bucket path (e.g. "client_drift-mv/<run>/<artifact>.png")
 * @param ttlSeconds expiry in seconds; caller is responsible for validating range
 * @returns the signed URL on success, or null on any failure (logged).
 */
export async function createArtifactSignedUrl(
  storagePath: string,
  ttlSeconds: number,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, ttlSeconds);

    if (error) {
      console.error(`[storage] createSignedUrl failed for ${storagePath}:`, error.message);
      return null;
    }
    if (!data?.signedUrl) {
      console.error(`[storage] createSignedUrl returned no URL for ${storagePath}`);
      return null;
    }
    return data.signedUrl;
  } catch (err) {
    console.error(`[storage] Unexpected error signing ${storagePath}:`, err);
    return null;
  }
}

function decodePngDataUrl(value: string): Buffer {
  const trimmed = value.trim();
  const dataUrlMatch = /^data:(image\/png);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(trimmed);
  const rawBase64 = dataUrlMatch ? dataUrlMatch[2] : trimmed;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(rawBase64)) {
    throw new Error("ref_image_data must be PNG base64 or a data:image/png;base64 URL");
  }
  const buffer = Buffer.from(rawBase64.replace(/\s+/g, ""), "base64");
  if (buffer.length === 0) {
    throw new Error("ref_image_data decoded to an empty file");
  }
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A.
  if (
    buffer.length < 8 ||
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47 ||
    buffer[4] !== 0x0d ||
    buffer[5] !== 0x0a ||
    buffer[6] !== 0x1a ||
    buffer[7] !== 0x0a
  ) {
    throw new Error("ref_image_data must decode to a PNG image");
  }
  return buffer;
}

export function buildRejectionLearningRefImagePath(
  clientId: string,
  runId: string,
  eventId: string,
): string {
  return `${clientId}/${runId}/learning/${eventId}.png`;
}

export async function uploadRejectionLearningReferenceImage(params: {
  clientId: string;
  runId: string;
  eventId: string;
  refImageData: string;
}): Promise<{ storagePath: string; size: number }> {
  const storagePath = buildRejectionLearningRefImagePath(params.clientId, params.runId, params.eventId);
  const buffer = decodePngDataUrl(params.refImageData);

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType: "image/png",
      upsert: false,
    });

  if (error) {
    throw new Error(`Failed to upload rejection learning reference image: ${error.message}`);
  }

  return { storagePath, size: buffer.length };
}

/**
 * Best-effort cleanup of an uploaded reference image when the atomic
 * Reject-as-Teach RPC rolls back. Returns true on success, false on any
 * failure (storage error or already-deleted). The caller logs but does not
 * re-throw — the primary error is what propagates to the operator.
 *
 * Resolves CodeRabbit PR #8 finding (os-api/src/db.ts:3552) — non-atomic
 * reject path could leave an orphan ref image even after the DB rollback.
 */
export async function deleteRejectionLearningReferenceImage(
  storagePath: string,
): Promise<boolean> {
  if (!storagePath) return false;
  const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
  if (error) {
    console.error(
      `[storage] reject-as-teach compensation: failed to delete orphan ref image ${storagePath}:`,
      error.message,
    );
    return false;
  }
  return true;
}
