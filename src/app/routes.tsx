import type { RouteObject } from 'react-router'
import { AppLayout } from './AppLayout'
import { HomeScreen } from '../features/home/HomeScreen'
import { SetupScreen } from '../features/setup/SetupScreen'
import { ScoringScreen } from '../features/scoring/ScoringScreen'
import { ScorecardScreen } from '../features/scoring/ScorecardScreen'
import { SettleScreen } from '../features/settle/SettleScreen'
import { CourseListScreen } from '../features/courses/CourseListScreen'
import { CourseEditorScreen } from '../features/courses/CourseEditorScreen'
import { DiagnosticsScreen } from '../features/diagnostics/DiagnosticsScreen'
import { PlayersScreen } from '../features/players/PlayersScreen'

export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <HomeScreen /> },
      { path: '/setup', element: <SetupScreen /> },
      { path: '/players', element: <PlayersScreen /> },
      { path: '/courses', element: <CourseListScreen /> },
      { path: '/diagnostics', element: <DiagnosticsScreen /> },
      { path: '/courses/new', element: <CourseEditorScreen /> },
      { path: '/courses/:courseId/edit', element: <CourseEditorScreen /> },
      { path: '/round/:roundId', element: <ScoringScreen /> },
      { path: '/round/:roundId/card', element: <ScorecardScreen /> },
      { path: '/round/:roundId/settle', element: <SettleScreen /> },
    ],
  },
]
