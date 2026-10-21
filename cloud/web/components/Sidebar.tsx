// The dashboard's frame: the project and environment you're looking at, the project's services
// (each opens its live queries), where else you can go,
// and whether the live feed is connected. On wide screens a column that folds down to a rail
// of icons (remembered in this browser); on narrow ones a fold-out menu.
import { BookOpenIcon, MenuIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, Rows3Icon, ServerCogIcon, SettingsIcon, XIcon } from 'lucide-react'
import { type ComponentType, useEffect, useState } from 'react'

import type { Backend } from '../../bindings/Backend'
import type { Project } from '../../bindings/Project'
import { Logo } from '@/components/Logo'
import { ConnectionStatus } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtCount } from '@/lib/format'
import type { Connection } from '@/lib/live'
import { type Route, href, navigate, onLinkClick } from '@/lib/router'
import { ALL, type Scope } from '@/lib/scope'
import { cn } from '@/lib/utils'

interface Props {
  route: Route
  /** The project; `null` before there is one. */
  project: Project | null
  /** With the service (`backend`) checked against the project. */
  scope: Scope
  onScope: (patch: Partial<Scope>) => void
  /** Environments seen in the loaded history, plus the chosen one. */
  environments: string[]
  connection: Connection
  /** Statements loaded for the project. */
  size: number
}

interface NavItem {
  label: string
  icon: ComponentType<{ className?: string }>
  route: Route
  pages: Route['page'][]
}

const SECONDARY: NavItem[] = [
  { label: 'Docs', icon: BookOpenIcon, route: { page: 'docs' }, pages: ['docs'] },
  { label: 'Settings', icon: SettingsIcon, route: { page: 'settings' }, pages: ['settings'] },
]

const COLLAPSED_KEY = 'querylens.sidebar.collapsed'

/** Whether the wide-screen sidebar is folded to its rail, remembered in this browser. */
export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const update = (c: boolean) => {
    setCollapsed(c)
    try {
      localStorage.setItem(COLLAPSED_KEY, c ? '1' : '0')
    } catch {
      // Not remembered: fine.
    }
  }
  return [collapsed, update]
}

const SCOPE_TRIGGER = 'h-8 w-full border-0 bg-transparent px-2 shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted'

/** The project's name, and the environment shown (one, or all). */
function ScopePicker({ project, scope, onScope, environments }: Pick<Props, 'project' | 'scope' | 'onScope' | 'environments'>) {
  return (
    <div className="grid gap-px rounded-lg border bg-card p-1">
      <p className="truncate px-2 py-1.5 text-sm font-semibold" title={project?.name}>
        {project?.name ?? 'No project'}
      </p>
      <Select value={scope.environment} onValueChange={(v) => onScope({ environment: v })}>
        <SelectTrigger className={cn(SCOPE_TRIGGER, 'text-muted-foreground')} aria-label="Environment">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All environments</SelectItem>
          {environments.map((e) => (
            <SelectItem key={e} value={e}>
              {e}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/** What the scope reads as, for the rail's tooltip. */
function scopeName({ project, scope }: Pick<Props, 'project' | 'scope'>): string {
  if (!project) return 'No project'
  const backend = scope.backend === ALL ? null : project.backends.find((b) => b.id === scope.backend)?.name
  return [project.name, backend, scope.environment === ALL ? 'all environments' : scope.environment].filter(Boolean).join(', ')
}

/** "Shop API" → "SA": the chosen project, on the rail. */
function initials(name: string): string {
  return name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}

/** Shown as a hint beside the rail's icons. */
function Hint({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

const NAV_LINK =
  'flex items-center gap-2.5 rounded-md py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50'
const NAV_ACTIVE = 'bg-primary/10 text-primary dark:bg-primary/15'
const NAV_IDLE = 'text-muted-foreground hover:bg-muted hover:text-foreground'

/** Reporting within this long reads as live in the services list. */
const RECENT_MS = 15 * 60_000

function serviceDot(b: Backend): string {
  if (!b.dsn) return 'bg-muted-foreground/30'
  if (b.lastSeen === null) return 'bg-warning'
  return Date.now() - Date.parse(b.lastSeen) < RECENT_MS ? 'bg-primary' : 'bg-muted-foreground/60'
}

function serviceState(b: Backend): string {
  if (!b.dsn) return 'disconnected'
  return b.lastSeen === null ? 'waiting for its first event' : 'connected'
}

/** The project page: "Manage services" under the list, "Connect a service" in place of an empty one. */
function ManageLink({ route, empty, rail }: { route: Route; empty: boolean; rail?: boolean }) {
  const label = empty ? 'Connect a service' : 'Manage services'
  const Icon = empty ? PlusIcon : ServerCogIcon
  const link = (
    <a
      href={href({ page: 'project' })}
      onClick={onLinkClick}
      aria-current={route.page === 'project' ? 'page' : undefined}
      aria-label={rail ? label : undefined}
      className={cn(NAV_LINK, rail ? 'size-9 justify-center' : 'px-2.5', route.page === 'project' ? NAV_ACTIVE : NAV_IDLE)}
    >
      <Icon className="size-4 shrink-0" />
      {!rail && label}
    </a>
  )
  return rail ? <Hint label={label}>{link}</Hint> : link
}

/**
 * The project's services, each opening its live queries ("All services" first when there are
 * several), then the link to manage them.
 */
function ServiceLinks({ project, scope, route, onScope, rail }: Pick<Props, 'project' | 'scope' | 'route' | 'onScope'> & { rail?: boolean }) {
  const onLive = route.page === 'live' || route.page === 'query'
  if (!project || project.backends.length === 0) return <ManageLink route={route} empty rail={rail} />
  const several = project.backends.length > 1
  const items: { id: string; name: string; service: Backend | null }[] = [
    ...(several ? [{ id: ALL, name: 'All services', service: null }] : []),
    ...project.backends.map((b) => ({ id: b.id, name: b.name, service: b })),
  ]
  return (
    <>
      {items.map(({ id, name, service }) => {
        const active = onLive && (!several || scope.backend === id)
        const label = service ? `${name}, ${serviceState(service)}` : name
        const link = (
          <a
            key={id}
            href={href({ page: 'live' })}
            onClick={(e) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
              e.preventDefault()
              onScope({ backend: id })
              navigate({ page: 'live' })
            }}
            aria-current={active ? 'page' : undefined}
            aria-label={rail ? label : undefined}
            title={rail ? undefined : label}
            className={cn(NAV_LINK, rail ? 'size-9 justify-center' : 'px-2.5', active ? NAV_ACTIVE : NAV_IDLE)}
          >
            {service ? (
              rail ? (
                <span className="relative text-xs font-semibold">
                  {initials(name)}
                  <span className={cn('absolute -top-0.5 -right-1.5 size-1.5 rounded-full', serviceDot(service))} aria-hidden />
                </span>
              ) : (
                <span className="grid size-4 shrink-0 place-items-center" aria-hidden>
                  <span className={cn('size-1.5 rounded-full', serviceDot(service))} />
                </span>
              )
            ) : (
              <Rows3Icon className="size-4 shrink-0" />
            )}
            {!rail && <span className={cn('truncate', service && !service.dsn && 'line-through decoration-muted-foreground/40')}>{name}</span>}
          </a>
        )
        return rail ? (
          <Hint key={id} label={label}>
            {link}
          </Hint>
        ) : (
          link
        )
      })}
      <ManageLink route={route} empty={false} rail={rail} />
    </>
  )
}

function NavLinks({ items, route, rail }: { items: NavItem[]; route: Route; rail?: boolean }) {
  return (
    <>
      {items.map((n) => {
        const active = n.pages.includes(route.page)
        const link = (
          <a
            key={n.label}
            href={href(n.route)}
            onClick={onLinkClick}
            aria-current={active ? 'page' : undefined}
            aria-label={rail ? n.label : undefined}
            className={cn(NAV_LINK, rail ? 'size-9 justify-center' : 'px-2.5', active ? NAV_ACTIVE : NAV_IDLE)}
          >
            <n.icon className="size-4 shrink-0" />
            {!rail && n.label}
          </a>
        )
        return rail ? (
          <Hint key={n.label} label={n.label}>
            {link}
          </Hint>
        ) : (
          link
        )
      })}
    </>
  )
}

function Contents(props: Props) {
  return (
    <>
      <ScopePicker {...props} />
      <nav aria-labelledby="nav-live" className="grid min-h-0 gap-0.5 overflow-y-auto">
        <p id="nav-live" className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">
          Live queries
        </p>
        <ServiceLinks {...props} />
      </nav>
      <div className="flex-1" />
      <nav aria-label="More" className="grid gap-0.5">
        <NavLinks items={SECONDARY} route={props.route} />
      </nav>
    </>
  )
}

/** The folded sidebar: the mark, the scope as initials, the pages as icons. */
function Rail(props: Props & { onExpand: () => void }) {
  const name = scopeName(props)
  return (
    <>
      <Hint label={`${name}. Expand to change`}>
        <button
          type="button"
          onClick={props.onExpand}
          aria-label={`${name}. Expand the sidebar to change`}
          className="grid size-9 place-items-center rounded-md border bg-card text-xs font-semibold text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {props.project ? initials(props.project.name) : <ServerCogIcon className="size-4 text-muted-foreground" aria-hidden />}
        </button>
      </Hint>
      <nav aria-label="Live queries" className="grid gap-0.5">
        <ServiceLinks {...props} rail />
      </nav>
      <div className="flex-1" />
      <nav aria-label="More" className="grid gap-0.5">
        <NavLinks items={SECONDARY} route={props.route} rail />
      </nav>
    </>
  )
}

export function Sidebar({ collapsed, onCollapsed, ...props }: Props & { collapsed: boolean; onCollapsed: (c: boolean) => void }) {
  const [open, setOpen] = useState(false)
  // A menu choice closes the menu.
  useEffect(() => setOpen(false), [props.route, props.scope])
  const home = (
    <a href={href({ page: 'live' })} onClick={onLinkClick} aria-label="QueryLens, live queries" className="w-fit rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      <Logo compact={collapsed} />
    </a>
  )
  const toggle = (
    <Hint label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
      <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => onCollapsed(!collapsed)}>
        {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
      </Button>
    </Hint>
  )
  return (
    <>
      <aside className={cn('sticky top-0 hidden h-dvh flex-col gap-5 overflow-hidden border-r bg-muted/30 py-4 lg:flex', collapsed ? 'items-center px-2' : 'px-3')}>
        <div className={cn('flex min-h-8 items-center', collapsed ? 'justify-center' : 'justify-between pl-1.5')}>
          {home}
          {!collapsed && toggle}
        </div>
        {collapsed ? <Rail {...props} onExpand={() => onCollapsed(false)} /> : <Contents {...props} />}
        <div className={cn('flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground', collapsed ? 'w-full flex-col' : 'justify-between px-1')}>
          {collapsed ? (
            <>
              <Hint label={`${{ live: 'Live', connecting: 'Connecting', offline: 'Reconnecting' }[props.connection]}, ${fmtCount(props.size)} statements`}>
                <span className="grid size-8 place-items-center">
                  <ConnectionStatus state={props.connection} dotOnly />
                </span>
              </Hint>
              {toggle}
            </>
          ) : (
            <>
              <ConnectionStatus state={props.connection} />
              <span className="tabular">{fmtCount(props.size)} statements</span>
            </>
          )}
        </div>
      </aside>
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur lg:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <a href={href({ page: 'live' })} onClick={onLinkClick} aria-label="QueryLens, live queries" className="w-fit rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <Logo />
          </a>
          <Button variant="ghost" size="icon" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <XIcon /> : <MenuIcon />}
          </Button>
        </div>
        {open && (
          <div className="flex flex-col gap-4 border-t px-4 py-4">
            <Contents {...props} />
            <div className="flex items-center justify-between gap-2 border-t px-1 pt-3 text-xs text-muted-foreground">
              <ConnectionStatus state={props.connection} />
              <span className="tabular">{fmtCount(props.size)} statements</span>
            </div>
          </div>
        )}
      </header>
    </>
  )
}
