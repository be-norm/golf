import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []

const supabaseMock = vi.hoisted(() => ({
  functions: { invoke: vi.fn() },
  auth: { signOut: vi.fn() },
}))
const wipeMock = vi.hoisted(() => vi.fn())

vi.mock('./supabase', () => ({ supabase: supabaseMock }))
vi.mock('../db/wipe', () => ({ wipeUserData: wipeMock }))

const { deleteAccount } = await import('./deleteAccount')

const UID = 'uid-123'

function online(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true })
}

describe('deleteAccount', () => {
  beforeEach(() => {
    calls.length = 0
    online(true)
    supabaseMock.functions.invoke.mockReset().mockImplementation(async () => {
      calls.push('remote')
      return { error: null }
    })
    supabaseMock.auth.signOut.mockReset().mockImplementation(async () => {
      calls.push('signOut')
    })
    wipeMock.mockReset().mockImplementation(async () => {
      calls.push('wipe')
    })
  })

  it('deletes remotely before touching local data', async () => {
    await deleteAccount(UID)
    // Order is the whole design: if the local wipe ran first and the network
    // call then failed, the user would be signed in to an account whose data we
    // had already destroyed.
    expect(calls).toEqual(['remote', 'wipe', 'signOut'])
  })

  it('leaves local data intact when the remote delete fails', async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ error: { message: 'boom' } })
    await expect(deleteAccount(UID)).rejects.toThrow(/could not delete/i)
    expect(wipeMock).not.toHaveBeenCalled()
    // Still signed in, still has their data — the operation is safely retryable.
    expect(supabaseMock.auth.signOut).not.toHaveBeenCalled()
  })

  it('refuses offline instead of half-deleting', async () => {
    online(false)
    await expect(deleteAccount(UID)).rejects.toThrow(/needs a connection/i)
    expect(supabaseMock.functions.invoke).not.toHaveBeenCalled()
    expect(wipeMock).not.toHaveBeenCalled()
  })

  it('still signs out if the local wipe fails', async () => {
    wipeMock.mockRejectedValue(new Error('dexie exploded'))
    await expect(deleteAccount(UID)).rejects.toThrow(/dexie exploded/)
    // The account is already gone server-side, but the access token is a
    // stateless JWT valid until it expires — skipping sign-out would leave the
    // app apparently signed in to an account that no longer exists.
    expect(supabaseMock.auth.signOut).toHaveBeenCalledTimes(1)
  })

  it('wipes only the deleted user’s partition', async () => {
    await deleteAccount(UID)
    expect(wipeMock).toHaveBeenCalledWith(UID)
  })
})
