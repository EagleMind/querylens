import { ChevronsDownUpIcon, ChevronsUpDownIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import type { PlanNode } from '@/bindings/PlanNode'
import { PaneLabel } from '@/components/shared/bits'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/store/workspace'

import { PlanNodeRow, ROW_GRID } from './PlanNodeRow'
import { flatten } from './heat'

/** Ancestor ids of a path id: "0.1.2" → ["0", "0.1"]. */
function ancestors(id: string): string[] {
  const parts = id.split('.')
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('.'))
}

/** Keyed by analysis id by the parent, so a new plan starts fully expanded. */
export function PlanTree({ root, timed }: { root: PlanNode; timed: boolean }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const selectedNodeId = useWorkspace((s) => s.selectedNodeId)
  const selectNode = useWorkspace((s) => s.selectNode)

  // The selected node (e.g. targeted by a suggestion card) is always revealed.
  const revealed = useMemo(() => new Set(selectedNodeId ? ancestors(selectedNodeId) : []), [selectedNodeId])
  const isCollapsed = (id: string) => collapsed.has(id) && !revealed.has(id)

  const toggle = useCallback(
    (id: string) => {
      // Collapsing an ancestor of the selection hides it, so drop the selection.
      if (revealed.has(id)) selectNode(null)
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(id) && !revealed.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    [revealed, selectNode],
  )

  const allCollapsible = flatten(root).filter((n) => n.children.length > 0 && n.id !== root.id)

  const rows: { node: PlanNode; depth: number }[] = []
  const visit = (n: PlanNode, depth: number) => {
    rows.push({ node: n, depth })
    if (!isCollapsed(n.id)) n.children.forEach((c) => visit(c, depth + 1))
  }
  visit(root, 0)

  return (
    <div role="tree" className="pb-6">
      <div className={`${ROW_GRID} sticky top-0 z-10 h-8 border-b bg-background/95 pr-4 pl-4 backdrop-blur`}>
        <div className="flex items-center gap-2">
          <PaneLabel>Operator</PaneLabel>
          {allCollapsible.length > 0 && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              title={collapsed.size ? 'Expand all' : 'Collapse all'}
              onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(allCollapsible.map((n) => n.id)))}
            >
              {collapsed.size ? <ChevronsUpDownIcon /> : <ChevronsDownUpIcon />}
            </Button>
          )}
        </div>
        <PaneLabel className="text-right">Rows act/est</PaneLabel>
        <PaneLabel className="text-right">{timed ? 'Self time' : 'Self cost'}</PaneLabel>
        <PaneLabel>Share</PaneLabel>
      </div>
      {rows.map(({ node, depth }) => (
        <PlanNodeRow
          key={node.id}
          node={node}
          depth={depth}
          timed={timed}
          collapsed={isCollapsed(node.id)}
          selected={node.id === selectedNodeId}
          onToggleCollapse={toggle}
          onSelect={selectNode}
        />
      ))}
    </div>
  )
}
