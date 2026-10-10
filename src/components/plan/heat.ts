import type { Heat } from '@/bindings/Heat'
import type { PlanNode } from '@/bindings/PlanNode'

export const HEAT_BG: Record<Heat, string> = {
  high: 'bg-heat-high',
  medium: 'bg-heat-medium',
  low: 'bg-heat-low',
}

export const HEAT_TEXT: Record<Heat, string> = {
  high: 'text-heat-high',
  medium: 'text-heat-medium',
  low: 'text-heat-low',
}

export function flatten(root: PlanNode): PlanNode[] {
  const out: PlanNode[] = []
  const walk = (n: PlanNode) => {
    out.push(n)
    n.children.forEach(walk)
  }
  walk(root)
  return out
}

export function findNode(root: PlanNode, id: string): PlanNode | null {
  if (root.id === id) return root
  for (const c of root.children) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}

/** "Seq Scan on orders" */
export function nodeLabel(n: PlanNode): string {
  return n.relation ? `${n.nodeType} on ${n.relation}` : n.nodeType
}

/** True when the plan carries any share information worth visualising. */
export function hasShares(root: PlanNode): boolean {
  return flatten(root).some((n) => n.share > 0)
}
