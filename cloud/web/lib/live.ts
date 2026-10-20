// The live feed: one WebSocket to the project's Durable Object, reconnecting with
// backoff. Keeps the latest requests and per-minute throughput for the Live page.
import { useEffect, useRef, useState } from 'react'

import type { Issue } from '../../bindings/Issue'
import type { LiveEvent } from '../../bindings/LiveEvent'
import { liveUrl } from './api'

export type LiveTransaction = Extract<LiveEvent, { type: 'transaction' }> & { key: number }

export interface Minute {
  /** Epoch ms of the minute's start. */
  at: number
  statements: number
  dbMs: number
  errors: number
}

export type Connection = 'connecting' | 'live' | 'offline'

export interface LiveState {
  connection: Connection
  transactions: LiveTransaction[]
  minutes: Minute[]
  /** Issues that appeared or came back since the page opened, newest first. */
  issues: { issue: Issue; regressed: boolean; at: number }[]
}

const KEEP_TRANSACTIONS = 300
const KEEP_MINUTES = 30
const MINUTE = 60_000

const empty: LiveState = { connection: 'connecting', transactions: [], minutes: [], issues: [] }

function addThroughput(minutes: Minute[], at: number, statements: number, dbMs: number, errors: number): Minute[] {
  const start = Math.floor(at / MINUTE) * MINUTE
  const next = minutes.filter((m) => m.at !== start)
  const current = minutes.find((m) => m.at === start)
  next.push({
    at: start,
    statements: (current?.statements ?? 0) + statements,
    dbMs: (current?.dbMs ?? 0) + dbMs,
    errors: (current?.errors ?? 0) + errors,
  })
  const cutoff = Math.floor(Date.now() / MINUTE) * MINUTE - (KEEP_MINUTES - 1) * MINUTE
  return next.filter((m) => m.at >= cutoff).sort((a, b) => a.at - b.at)
}

export function useLiveFeed(projectId: string | null, paused: boolean): LiveState {
  const [state, setState] = useState<LiveState>(empty)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    if (!projectId) return
    setState(empty)
    let ws: WebSocket | null = null
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let ping: ReturnType<typeof setInterval> | undefined
    let closed = false
    let key = 0

    const apply = (events: LiveEvent[]) =>
      setState((s) => {
        let { transactions, minutes, issues } = s
        const fresh: LiveTransaction[] = []
        for (const e of events) {
          if (e.type === 'transaction') {
            if (!pausedRef.current) fresh.push({ ...e, key: ++key })
          } else if (e.type === 'throughput') {
            // A five-minute report is spread evenly over its minutes.
            const start = new Date(e.at).getTime()
            const n = Math.max(1, Math.round(e.periodMs / MINUTE))
            for (let i = 0; i < n; i++) {
              minutes = addThroughput(minutes, start + i * MINUTE, e.calls / n, e.totalMs / n, e.errors / n)
            }
          } else if (e.type === 'issue') {
            issues = [{ issue: e.issue, regressed: e.regressed, at: Date.now() }, ...issues].slice(0, 20)
          }
        }
        if (fresh.length) transactions = [...fresh.reverse(), ...transactions].slice(0, KEEP_TRANSACTIONS)
        return { ...s, transactions, minutes, issues }
      })

    const connect = () => {
      setState((s) => ({ ...s, connection: 'connecting' }))
      ws = new WebSocket(liveUrl(projectId))
      ws.onopen = () => {
        retry = 0
        setState((s) => ({ ...s, connection: 'live' }))
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 30_000)
      }
      ws.onmessage = (m) => {
        if (typeof m.data !== 'string' || m.data === 'pong') return
        try {
          const msg = JSON.parse(m.data)
          if (msg.type === 'batch') apply(msg.events as LiveEvent[])
        } catch {
          // Not ours.
        }
      }
      ws.onclose = () => {
        clearInterval(ping)
        if (closed) return
        setState((s) => ({ ...s, connection: 'offline' }))
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++))
      }
    }
    connect()
    return () => {
      closed = true
      clearTimeout(timer)
      clearInterval(ping)
      ws?.close()
    }
  }, [projectId])

  return state
}
