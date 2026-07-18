import 'fake-indexeddb/auto'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { routes } from '../../app/routes'

describe('HomeScreen', () => {
  it('renders the app name and new-round entry', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/'] })
    render(<RouterProvider router={router} />)
    expect(await screen.findByRole('heading', { name: 'Golf' })).toBeInTheDocument()
    expect(screen.getByText('New round')).toBeInTheDocument()
  })
})
