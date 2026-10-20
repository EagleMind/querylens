import { useId } from 'react'

/** The rounded "Q", with the corner cut out for the cursor. */
const Q_PATH =
  'M11 2h10a9 9 0 0 1 9 9v10a9 9 0 0 1-9 9H11a9 9 0 0 1-9-9V11a9 9 0 0 1 9-9z' +
  'M12 9h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3z'

/** The QueryLens mark (a rounded "Q" whose tail is a block cursor) and wordmark. */
export function Logo() {
  const mask = useId()
  return (
    <span className="inline-flex items-center gap-2">
      <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
        <mask id={mask}>
          <rect width="32" height="32" fill="#fff" />
          <rect x="17.5" y="17.5" width="13" height="13" rx="3" fill="#000" />
        </mask>
        <path d={Q_PATH} fill="currentColor" fillRule="evenodd" mask={`url(#${mask})`} />
        <rect x="20" y="20" width="10" height="10" rx="1.5" fill="var(--primary)" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">QueryLens</span>
    </span>
  )
}
