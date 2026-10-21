// The dashboard's frame: what you're looking at (project and environment), where you can go,
// and whether the live feed is connected. On wide screens a column that folds down to a rail
// of icons (remembered in this browser); on narrow ones a fold-out menu.
import { BookOpenIcon, LayersIcon, MenuIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, Rows3Icon, SettingsIcon, XIcon } from 'lucide-react'
import { type ComponentType, useEffect, useState } from 'react'

import type { Project } from '../../bindings/Project'
import { Logo } from '@/components/Logo'
import { ConnectionStatus } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtCount } from '@/lib/format'
import type { Connection } from '@/lib/live'
import { type Route, href, onLinkClick } from '@/lib/router'
import { ALL, type Scope } from '@/lib/scope'
import { cn } from '@/lib/utils'

interface Props {
  route: Route
  projects: Project[]
  scope: Scope
  onScope: (patch: Partial<Scope>) => void
  /** Environments seen in the loaded history, plus the chosen one. */
  environments: string[]
  connection: Connection
  /** Statements loaded, across projects. */
  size: number
}

interface NavItem {
  label: string
  icon: ComponentType<{ className?: string }>
  route: Route
  pages: Route['page'][]
}

const MAIN: NavItem[] = [{ label: 'Live queries', icon: Rows3Icon, route: { page: 'live' }, pages: ['live', 'query'] }]
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

function ScopePicker({ projects, scope, onScope, environments }: Pick<Props, 'projects' | 'scope' | 'onScope' | 'environments'>) {
  return (
    <div className="grid gap-px rounded-lg border bg-card p-1">
      <Select value={scope.project} onValueChange={(v) => onScope({ project: v })}>
        <SelectTrigger className={cn(SCOPE_TRIGGER, 'font-medium')} aria-label="Project">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All projects</SelectItem>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
function scopeName({ projects, scope }: Pick<Props, 'projects' | 'scope'>): string {
  const project = scope.project === ALL ? 'All projects' : (projects.find((p) => p.id === scope.project)?.name ?? 'All projects')
  return `${project}, ${scope.environment === ALL ? 'all environments' : scope.environment}`
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
            className={cn(
              'flex items-center gap-2.5 rounded-md py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
              rail ? 'size-9 justify-center' : 'px-2.5',
              active ? 'bg-primary/10 text-primary dark:bg-primary/15' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
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
      <nav aria-label="Main" className="grid gap-0.5">
        <NavLinks items={MAIN} route={props.route} />
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
  const project = props.projects.find((p) => p.id === props.scope.project)
  return (
    <>
      <Hint label={`${name}. Expand to change`}>
        <button
          type="button"
          onClick={props.onExpand}
          aria-label={`${name}. Expand the sidebar to change`}
          className="grid size-9 place-items-center rounded-md border bg-card text-xs font-semibold text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {project ? initials(project.name) : <LayersIcon className="size-4 text-muted-foreground" aria-hidden />}
        </button>
      </Hint>
      <nav aria-label="Main" className="grid gap-0.5">
        <NavLinks items={MAIN} route={props.route} rail />
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
