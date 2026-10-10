import type { CSSProperties } from 'react'
import { Outlet } from 'react-router'

import { ConnectionDialog } from '@/components/connections/ConnectionDialog'
import { AppSidebar } from '@/components/layout/AppSidebar'
import { CompareDialog } from '@/components/plan/CompareDialog'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'

export function AppShell() {
  return (
    <SidebarProvider className="h-svh" style={{ '--sidebar-width': '15rem' } as CSSProperties}>
      <AppSidebar />
      <SidebarInset className="min-w-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
      <ConnectionDialog />
      <CompareDialog />
    </SidebarProvider>
  )
}
