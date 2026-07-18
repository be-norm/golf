import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HomeScreen } from './HomeScreen'

describe('HomeScreen', () => {
  it('renders the app name', () => {
    render(<HomeScreen />)
    expect(screen.getByRole('heading', { name: 'Golf' })).toBeInTheDocument()
  })
})
