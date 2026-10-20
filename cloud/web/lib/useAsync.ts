import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react'

export interface Async<T> {
  data: T | undefined
  error: unknown
  loading: boolean
  reload: () => void
}

/** Load `fn` when `deps` change; a reload keeps showing the previous data until it lands. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): Async<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const latest = useRef(0)

  useEffect(() => {
    const run = ++latest.current
    setLoading(true)
    fn().then(
      (v) => {
        if (run !== latest.current) return
        setData(v)
        setError(null)
        setLoading(false)
      },
      (e) => {
        if (run !== latest.current) return
        setError(e)
        setLoading(false)
      },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, reload }
}
