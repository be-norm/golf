import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const authMock = vi.hoisted(() => {
  let sessionValue: unknown = null
  return {
    setSession(s: unknown) {
      sessionValue = s
    },
    auth: {
      getSession: vi.fn(async () => ({ data: { session: sessionValue } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  }
})

vi.mock('../remote/supabase', () => ({ supabase: { auth: authMock.auth } }))
vi.mock('../remote/sync', () => ({ syncNow: vi.fn(async () => {}) }))

const { AuthProvider, useAuth } = await import('./AuthProvider')

function Probe() {
  const { loading, activeUserId, isGuest } = useAuth()
  if (loading) return <div>loading</div>
  return <div>{`${isGuest ? 'guest' : 'user'}:${activeUserId}`}</div>
}

describe('AuthProvider', () => {
  it('gates on the initial getSession, then resolves to the guest sentinel', async () => {
    authMock.setSession(null)
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    // First paint is gated — never a guest flash before the session resolves.
    expect(screen.getByText('loading')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('guest:@local')).toBeInTheDocument())
  })

  it('resolves to the signed-in user id', async () => {
    authMock.setSession({ user: { id: 'uid-123', email: 'a@b.com', user_metadata: {} } })
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByText('user:uid-123')).toBeInTheDocument())
  })
})
