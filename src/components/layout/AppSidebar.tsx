import {
  DatabaseIcon,
  FlameIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RadioIcon,
  ScanSearchIcon,
  SettingsIcon,
  LightbulbIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router'

import type { Connection } from '@/bindings/Connection'
import { LogoMark, Wordmark } from '@/components/brand/Logo'
import { ColorDot, EngineBadge } from '@/components/shared/bits'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
} from '@/components/ui/sidebar'
import { PROVIDERS } from '@/lib/constants'
import { useConnections, useDeleteConnection, useSettings } from '@/lib/queries'
import { useUi } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'

const NAV = [
  { to: '/', label: 'Workbench', icon: ScanSearchIcon },
  { to: '/capture', label: 'Capture', icon: RadioIcon },
  { to: '/top-queries', label: 'Top queries', icon: FlameIcon },
  { to: '/history', label: 'History', icon: HistoryIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

/** Active item: a signal-yellow tick on the left edge instead of a filled pill. */
const ACTIVE =
  'relative data-[active=true]:bg-sidebar-accent data-[active=true]:font-semibold data-[active=true]:before:absolute data-[active=true]:before:inset-y-1.5 data-[active=true]:before:-left-2 data-[active=true]:before:w-[3px] data-[active=true]:before:rounded-r-sm data-[active=true]:before:bg-signal'

export function AppSidebar() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { data: connections, isLoading } = useConnections()
  const { data: settings } = useSettings()
  const connectionId = useWorkspace((s) => s.connectionId)
  const setConnectionId = useWorkspace((s) => s.setConnectionId)
  const openDialog = useUi((s) => s.openConnectionDialog)
  const [pendingDelete, setPendingDelete] = useState<Connection | null>(null)
  const deleteConnection = useDeleteConnection()

  const provider = settings ? PROVIDERS[settings.llm.provider] : null

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-12 justify-center border-b border-sidebar-border px-3">
        <div className="flex items-center gap-2 overflow-hidden">
          <LogoMark className="size-[22px] shrink-0 text-foreground" />
          <Wordmark className="group-data-[collapsible=icon]:hidden" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton asChild isActive={pathname === item.to} tooltip={item.label} className={ACTIVE}>
                    <NavLink to={item.to}>
                      <item.icon />
                      <span>{item.label}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Connections</SidebarGroupLabel>
          <SidebarGroupAction title="New connection" onClick={() => openDialog()}>
            <PlusIcon />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading && [0, 1].map((i) => <SidebarMenuSkeleton key={i} showIcon />)}
              {connections?.length === 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={() => openDialog()} className="text-muted-foreground">
                    <DatabaseIcon />
                    <span>Add a connection</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {connections?.map((c) => (
                <SidebarMenuItem key={c.id}>
                  <SidebarMenuButton
                    isActive={c.id === connectionId}
                    className={ACTIVE}
                    tooltip={c.name}
                    onClick={() => {
                      setConnectionId(c.id)
                      if (pathname !== '/') navigate('/')
                    }}
                  >
                    <span className="flex size-4 items-center justify-center">
                      <ColorDot color={c.color} />
                    </span>
                    <span className="truncate">{c.name}</span>
                    <EngineBadge engine={c.engine} className="ml-auto group-hover/menu-item:opacity-0" />
                  </SidebarMenuButton>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <SidebarMenuAction showOnHover>
                        <MoreHorizontalIcon />
                      </SidebarMenuAction>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="right" align="start">
                      <DropdownMenuItem onClick={() => openDialog(c)}>
                        <PencilIcon /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setPendingDelete(c)}>
                        <Trash2Icon /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="Advisor">
              <NavLink to="/settings">
                <LightbulbIcon className="text-foreground/70" />
                <div className="grid min-w-0 leading-tight">
                  <span className="truncate text-xs font-medium">{provider?.label ?? 'Advisor'}</span>
                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                    {settings?.llm.model || 'default model'}
                  </span>
                </div>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The saved connection and its keychain password are removed. History entries are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!pendingDelete) return
                deleteConnection.mutate(pendingDelete.id)
                if (pendingDelete.id === connectionId) setConnectionId(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sidebar>
  )
}
