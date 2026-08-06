import 'fake-indexeddb/auto'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authMock = vi.hoisted(() => {
  let sessionValue: unknown = null
  return {
    setSession(s: unknown) {
      sessionValue = s
    },
    auth: {
      getSession: vi.fn(async () => ({ data: { session: sessionValue } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(async () => {}),
    },
  }
})
const deleteAccountMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../../remote/supabase', () => ({ supabase: { auth: authMock.auth } }))
// ClaimPrompt (rendered by AppLayout for signed-in users) pulls the other two —
// a partial mock here leaves it calling `undefined` and crashes the whole tree.
vi.mock('../../remote/sync', () => ({
  syncNow: vi.fn(async () => {}),
  countLocalGuestData: vi.fn(async () => ({ rounds: 0, players: 0, courses: 0 })),
  claimLocalData: vi.fn(async () => ({ rounds: 0, players: 0, courses: 0 })),
}))
vi.mock('../../remote/deleteAccount', () => ({ deleteAccount: deleteAccountMock }))

const { routes } = await import('../../app/routes')

function renderAccount() {
  const router = createMemoryRouter(routes, { initialEntries: ['/account'] })
  return render(<RouterProvider router={router} />)
}

const SIGNED_IN = { user: { id: 'uid-123', email: 'ben@example.com', user_metadata: {} } }

describe('AccountScreen', () => {
  beforeEach(() => {
    deleteAccountMock.mockClear()
    deleteAccountMock.mockResolvedValue(undefined)
  })

  it('offers deletion to a signed-in user without hunting for it', async () => {
    authMock.setSession(SIGNED_IN)
    renderAccount()
    // Guideline 5.1.1(v) requires deletion to be easy to FIND — it must be on
    // the account screen itself, not behind another layer of navigation.
    expect(await screen.findByRole('button', { name: /delete account/i })).toBeInTheDocument()
    expect(screen.getByText(/ben@example\.com/)).toBeInTheDocument()
  })

  it('does not delete until the user confirms', async () => {
    authMock.setSession(SIGNED_IN)
    renderAccount()
    await userEvent.click(await screen.findByRole('button', { name: /delete account/i }))

    // The sheet is open, but nothing has happened yet.
    expect(await screen.findByText(/deletion completes within 30 days/i)).toBeInTheDocument()
    expect(deleteAccountMock).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(deleteAccountMock).not.toHaveBeenCalled()
  })

  it('deletes once confirmed', async () => {
    authMock.setSession(SIGNED_IN)
    renderAccount()
    await userEvent.click(await screen.findByRole('button', { name: /delete account/i }))
    await userEvent.click(screen.getByRole('button', { name: /yes, delete everything/i }))

    await waitFor(() => expect(deleteAccountMock).toHaveBeenCalledTimes(1))
  })

  it('surfaces a failure and leaves the user signed in', async () => {
    authMock.setSession(SIGNED_IN)
    deleteAccountMock.mockRejectedValue(new Error('Could not delete your account.'))
    renderAccount()
    await userEvent.click(await screen.findByRole('button', { name: /delete account/i }))
    await userEvent.click(screen.getByRole('button', { name: /yes, delete everything/i }))

    // A failed delete must say so rather than silently appearing to succeed —
    // the user has to know whether their data is actually gone.
    expect(await screen.findByText(/could not delete your account/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /yes, delete everything/i })).toBeEnabled()
  })

  it('tells the user how long deletion takes before they confirm', async () => {
    authMock.setSession(SIGNED_IN)
    renderAccount()
    await userEvent.click(await screen.findByRole('button', { name: /delete account/i }))

    // Apple 5.1.1(v) accepts deletion that takes time to complete, but only if
    // the user is told how long — so the window is a requirement, not flavour.
    expect(await screen.findByText(/deletion completes within 30 days/i)).toBeInTheDocument()
    // The email frees up immediately, so re-signup must not look blocked.
    expect(screen.getByText(/sign up again with the same email/i)).toBeInTheDocument()
  })

  it('shows no danger zone for a guest', async () => {
    authMock.setSession(null)
    renderAccount()
    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete account/i })).not.toBeInTheDocument()
  })
})
