// The backend's own API types, beyond the analysis types querylens-core generates (bindings/).
// Imported by the Worker and the dashboard.
import type { IssueDetail } from '../bindings/IssueDetail'
import type { IssueEvent } from '../bindings/IssueEvent'
import type { Orm } from '../bindings/Orm'
import type { SourceSnippet } from '../bindings/SourceSnippet'
import type { StatementKind } from '../bindings/StatementKind'
import type { FilterDraft } from './filters'

// ───────────────────────────── issue context ─────────────────────────────

/** Everything known about an issue that helps fix it: what a coding agent or a model is given. */
export interface IssueContext {
  project: { id: string; name: string; orm: Orm | null }
  detail: IssueDetail
  /** The latest request that showed it, with every statement it ran. */
  latest: IssueEvent | null
  /** Code around the issue's origins, when the SDK sends source context. */
  sources: SourceSnippet[]
}

/** A Markdown brief for a coding agent working in the app's repository. */
export interface FixPrompt {
  prompt: string
}

// ───────────────────────────── regressions ─────────────────────────────

/** What a regression is measured against. */
export type Baseline =
  /** Before and since the deploy of `release` (first seen at `since`). */
  | { kind: 'release'; release: string; previous: string | null; since: string }
  /** No releases reported: the last 24 hours against the 7 days before. */
  | { kind: 'window'; since: string }

/** A statement shape's totals on one side of the baseline. */
export interface ShapeWindow {
  calls: number
  meanMs: number
  /** Failed calls / calls, 0–1. */
  errorRate: number
  /** Hours with any calls. */
  hours: number
}

export type RegressionKind = 'slower' | 'failing'

export interface Regression {
  fingerprint: string
  sampleSql: string
  kind: StatementKind
  tables: string[]
  regression: RegressionKind
  before: ShapeWindow
  after: ShapeWindow
  /** Extra statement time it costs per hour now, ms (`slower`), or extra failures per hour (`failing`). */
  costPerHour: number
  /** The newest stored run of the statement, to open its report; `null` when none is kept. */
  latest: { request: number; seq: number } | null
}

export interface RegressionReport {
  environment: string
  baseline: Baseline
  regressions: Regression[]
}

// ───────────────────────────── AI ─────────────────────────────

/** A rewrite of the application code responsible for an issue, from a model. */
export interface Suggestion {
  issueId: number
  /** One or two sentences: what changes and why it fixes the issue. */
  summary: string
  /** The file it applies to, and the first line replaced. */
  file: string
  line: number
  /** Lines of the app's code as they are (exactly as sent by the SDK)… */
  before: string
  /** …and as they should be. */
  after: string
  /** Things to check: other call sites, a migration, behaviour that changes. */
  notes: string[]
  model: string
  createdAt: string
}

/** Why the backend can't write a suggestion for an issue. */
export type SuggestionUnavailable =
  /** The SDK hasn't sent the code around the issue's origin. */
  | 'needs_source'
  /** No line of application code is known for the issue. */
  | 'no_origin'
  /** Workers AI isn't bound to this Worker. */
  | 'ai_unavailable'

/** An issue's suggestion as the dashboard shows it. */
export interface SuggestionState {
  /** The latest one written, if any. */
  suggestion: Suggestion | null
  /** The issue or its code changed since it was written. */
  stale: boolean
  /** Why none can be written now; `null` when one can. */
  unavailable: SuggestionUnavailable | null
}

export interface DraftFilterRequest {
  /** What the user typed: "slow writes on checkout". */
  text: string
  /** Releases seen lately, newest first, so "the last release" can be resolved. */
  releases?: string[]
}

export interface DraftFilterReply {
  draft: FilterDraft
  model: string
}
