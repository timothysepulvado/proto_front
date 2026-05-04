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
