/** The QueryLens mark (a "Q" whose tail is a query-plan branch) and wordmark. */
export function Logo() {
  return (
    <span className="inline-flex items-center gap-2">
      <svg viewBox="0 0 32 32" fill="none" className="size-6" aria-hidden>
        <circle cx="13.5" cy="12.5" r="8.5" stroke="currentColor" strokeWidth="2.6" />
        <circle cx="13.5" cy="12.5" r="2.6" fill="var(--signal)" />
        <path d="M13.5 21v6.25h7.5" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" />
        <rect x="21" y="24" width="6.5" height="6.5" rx="1" fill="var(--signal)" />
      </svg>
      <span className="font-display text-[17px] leading-none tracking-[-0.02em] lowercase" style={{ fontStretch: '85%' }}>
        <span className="font-bold">query</span>
        <span className="font-light text-foreground/75">lens</span>
      </span>
    </span>
  )
}
