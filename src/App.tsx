import { QueryClientProvider } from '@tanstack/react-query'
import { HashRouter, Route, Routes } from 'react-router'

import { AppShell } from '@/components/layout/AppShell'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { queryClient } from '@/lib/queries'
import { AnalyzeRoute } from '@/routes/analyze'
import { HistoryRoute } from '@/routes/history'
import { SettingsRoute } from '@/routes/settings'
import { TopQueriesRoute } from '@/routes/top-queries'

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <HashRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<AnalyzeRoute />} />
              <Route path="history" element={<HistoryRoute />} />
              <Route path="top-queries" element={<TopQueriesRoute />} />
              <Route path="settings" element={<SettingsRoute />} />
            </Route>
          </Routes>
        </HashRouter>
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
