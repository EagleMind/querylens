import { useId } from 'react'

/** The rounded "Q", with the corner cut out for the cursor. */
const Q_PATH =
  'M11 2h10a9 9 0 0 1 9 9v10a9 9 0 0 1-9 9H11a9 9 0 0 1-9-9V11a9 9 0 0 1 9-9z' +
  'M12 9h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3z'

/**
 * The QueryLens mark and wordmark. The mark is a heavy rounded "Q" whose tail is
 * a block cursor, cut out of the corner: the one query that got selected.
 */
export function Logo() {
  const mask = useId()
  return (
    <span className="inline-flex items-center gap-2">
      <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
        <mask id={mask}>
          <rect width="32" height="32" fill="#fff" />
          <rect x="17.5" y="17.5" width="13" height="13" rx="3" fill="#000" />
        </mask>
        <path d={Q_PATH} fill="currentColor" fillRule="evenodd" mask={`url(#${mask})`} />
        <rect x="20" y="20" width="10" height="10" rx="1.5" fill="var(--signal)" />
      </svg>
      <span className="font-display text-[17px] leading-none tracking-[-0.02em] lowercase" style={{ fontStretch: '85%' }}>
        <span className="font-bold">query</span>
        <span className="font-light text-foreground/75">lens</span>
      </span>
    </span>
  )
}
