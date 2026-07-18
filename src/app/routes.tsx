import type { RouteObject } from 'react-router'
import { AppLayout } from './AppLayout'
import { HomeScreen } from '../features/home/HomeScreen'
import { SetupScreen } from '../features/setup/SetupScreen'
import { ScoringScreen } from '../features/scoring/ScoringScreen'
import { ScorecardScreen } from '../features/scoring/ScorecardScreen'

export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <HomeScreen /> },
      { path: '/setup', element: <SetupScreen /> },
      { path: '/round/:roundId', element: <ScoringScreen /> },
      { path: '/round/:roundId/card', element: <ScorecardScreen /> },
    ],
  },
]
