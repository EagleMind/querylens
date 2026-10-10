import type { AnalysisResult } from '@/bindings/AnalysisResult'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/store/workspace'

import { SuggestionPanel } from './SuggestionPanel'
import { WhatIfPanel } from './WhatIfPanel'

/** Right-hand panel: the Advisor (LLM) and What-if (planner experiments) side by side as tabs. */
export function InsightsPanel({ analysis }: { analysis: AnalysisResult | null }) {
  const tab = useWorkspace((s) => s.insightsTab)
  const setTab = useWorkspace((s) => s.setInsightsTab)
  const whatifRunning = useWorkspace((s) => s.whatif.status === 'running')
  const advisorRunning = useWorkspace((s) => s.stream.status === 'streaming')

  const tabs = (
    <div role="tablist" className="flex items-center gap-4">
      {(
        [
          ['advisor', 'Advisor', advisorRunning],
          ['whatif', 'What-if', whatifRunning],
        ] as const
      ).map(([id, label, busy]) => (
        <button
          key={id}
          role="tab"
          aria-selected={tab === id}
          type="button"
          onClick={() => setTab(id)}
          className={cn(
            'relative font-display text-[16px] font-semibold transition-colors',
            tab === id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          style={{ fontStretch: '90%' }}
        >
          {label}
          {busy && tab !== id && <span className="absolute -top-0.5 -right-2 size-1.5 rounded-full bg-signal" />}
          {tab === id && <span className="absolute inset-x-0 -bottom-[13px] h-[2px] bg-signal" />}
        </button>
      ))}
    </div>
  )

  return tab === 'advisor' ? (
    <SuggestionPanel analysis={analysis} tabs={tabs} />
  ) : (
    <WhatIfPanel analysis={analysis} tabs={tabs} />
  )
}
