import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../remote/supabase'
import { LOCAL_USER } from '../db/ids'
import { syncNow } from '../remote/sync'

export interface AuthValue {
  session: Session | null
  user: User | null
  /** Owner partition for repo queries: the auth uid, or LOCAL_USER when guest. */
  activeUserId: string
  isGuest: boolean
  /** True until the initial getSession() resolves — gate UI on this to avoid a
   *  guest flash for a signed-in user on every launch. */
  loading: boolean
  displayName: string | null
  signInWithPassword: (email: string, password: string) => Promise<{ error: string | null }>
  signUpWithPassword: (
    email: string,
    password: string,
  ) => Promise<{ error: string | null; needsConfirmation: boolean }>
  signInWithGoogle: () => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

/** Where Google returns after OAuth — the app's base under this origin
 *  (e.g. https://be-norm.github.io/golf/ or http://localhost:5173/golf/). */
const OAUTH_REDIRECT = `${window.location.origin}${import.meta.env.BASE_URL}`

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return
        setSession(data.session)
        setLoading(false)
      })
      .catch(() => {
        // Never brick the boot on a session-read failure — fall back to guest.
        // Offline-first: the app must render with zero connectivity.
        if (active) setLoading(false)
      })
    // Never derive sign-in from token validity — an expired token offline still
    // yields a session with user.id, and we must not sign the user out locally.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
    })
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  // Restore from the cloud on sign-in, and re-sync when we regain focus/network.
  const userId = session?.user?.id
  useEffect(() => {
    if (!userId) return
    void syncNow(userId)
    const onWake = () => void syncNow(userId)
    const onVisible = () => {
      if (document.visibilityState === 'visible') onWake()
    }
    window.addEventListener('online', onWake)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', onWake)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [userId])

  const value = useMemo<AuthValue>(() => {
    const user = session?.user ?? null
    const meta = user?.user_metadata as { name?: string; full_name?: string } | undefined
    return {
      session,
      user,
      activeUserId: user?.id ?? LOCAL_USER,
      isGuest: !user,
      loading,
      displayName: meta?.name ?? meta?.full_name ?? user?.email ?? null,
      async signInWithPassword(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        return { error: error?.message ?? null }
      },
      async signUpWithPassword(email, password) {
        const { data, error } = await supabase.auth.signUp({ email, password })
        // With email confirmation on, signUp succeeds but returns no session —
        // the user must click the emailed link first.
        return { error: error?.message ?? null, needsConfirmation: !error && !data.session }
      },
      async signInWithGoogle() {
        const { error } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo: OAUTH_REDIRECT },
        })
        return { error: error?.message ?? null }
      },
      async signOut() {
        await supabase.auth.signOut()
      },
    }
  }, [session, loading])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
