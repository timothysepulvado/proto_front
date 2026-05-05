import { useEffect, useState } from "react";
import { getSignedArtifactUrl } from "../api";

interface CachedSignedArtifactUrl {
  url: string;
  expiresAtMs: number;
}

interface UseSignedArtifactUrlResult {
  url: string | null;
  loading: boolean;
  error: string | null;
}

// In-memory module-level cache; never persisted. Scoped to a single tab session.
// Key: artifactId. Value: signed URL plus absolute expiry. Refresh inside the buffer.
const cache = new Map<string, CachedSignedArtifactUrl>();
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function readFreshCacheEntry(artifactId: string, now = Date.now()): CachedSignedArtifactUrl | null {
  const hit = cache.get(artifactId);
  if (!hit) return null;
  return hit.expiresAtMs - now > REFRESH_BUFFER_MS ? hit : null;
}

export function useSignedArtifactUrl(artifactId: string | undefined): UseSignedArtifactUrlResult {
  const [url, setUrl] = useState<string | null>(() => {
    if (!artifactId) return null;
    return readFreshCacheEntry(artifactId)?.url ?? null;
  });
  const [loading, setLoading] = useState<boolean>(() => !url && !!artifactId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!artifactId) {
      setUrl(null);
      setLoading(false);
      setError(null);
      return;
    }

    const hit = readFreshCacheEntry(artifactId);
    if (hit) {
      setUrl(hit.url);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    setUrl(null);
    setLoading(true);
    setError(null);

    getSignedArtifactUrl(artifactId)
      .then((res) => {
        if (cancelled) return;

        const expiresAtMs = new Date(res.expiresAt).getTime();
        cache.set(artifactId, { url: res.signedUrl, expiresAtMs });
        setUrl(res.signedUrl);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;

        setError(err instanceof Error ? err.message : String(err));
        setUrl(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  return { url, loading, error };
}
