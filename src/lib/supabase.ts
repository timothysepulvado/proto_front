import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables')
}

let clientAccessToken: string | null = null

export function setSupabaseClientAccessToken(token: string | null) {
  clientAccessToken = token
}

/**
 * Read the current client JWT for direct os-api fetches.
 *
 * The token is set by `clientAuth.ts::applyClientJwt` (via
 * `setSupabaseClientAccessToken`) and cleared by `clearClientJwtRefresh`.
 * It lives in this module's private scope as the single source of truth —
 * the supabase-js global `fetch` wrapper above reads it directly; raw
 * `fetch()` calls in `src/api.ts` go through `getAuthHeaders()` in
 * `lib/apiAuth.ts` which calls this accessor.
 *
 * Returns `null` when no JWT is active (bootstrap-fallback path matches
 * the os-api endpoint contract: no enforcement when JWT_AUTH_ENABLED=false).
 */
export function getCurrentClientToken(): string | null {
  return clientAccessToken
}

const fetchWithClientAuth: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  if (clientAccessToken) {
    headers.set('Authorization', `Bearer ${clientAccessToken}`)
  }
  return fetch(input, { ...init, headers })
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  global: {
    fetch: fetchWithClientAuth,
  },
})
