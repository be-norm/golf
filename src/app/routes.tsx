import type { RouteObject } from 'react-router'
import { AppLayout } from './AppLayout'
import { HomeScreen } from '../features/home/HomeScreen'

export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    children: [{ path: '/', element: <HomeScreen /> }],
  },
]
