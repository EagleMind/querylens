// The list of projects, the backend-wide settings and the daily allowance of AI calls: one
// small Durable Object, touched only by the dashboard and MCP clients (never on the ingest
// path, which goes straight to each project's own object).
import { DurableObject } from 'cloudflare:workers'

export interface ProjectEntry {
  id: string
  name: string
  createdAt: string
}

export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)',
      )
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS ai_calls (day TEXT PRIMARY KEY, calls INTEGER NOT NULL)')
    })
  }

  async add(id: string, name: string): Promise<void> {
    this.ctx.storage.sql.exec('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)', id, name, new Date().toISOString())
  }

  async rename(id: string, name: string): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE projects SET name = ? WHERE id = ?', name, id)
  }

  /** The address apps reach this backend at (it goes into every DSN); `null` = the dashboard's own. */
  async publicUrl(): Promise<string | null> {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = 'public_url'").toArray()[0]
    return row?.value ?? null
  }

  async setPublicUrl(url: string | null): Promise<void> {
    if (url) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('public_url', ?)", url)
    else this.ctx.storage.sql.exec("DELETE FROM settings WHERE key = 'public_url'")
  }

  async list(): Promise<ProjectEntry[]> {
    return this.ctx.storage.sql
      .exec<{ id: string; name: string; created_at: string }>('SELECT id, name, created_at FROM projects ORDER BY created_at')
      .toArray()
      .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }))
  }

  /**
   * Count one AI call against today's allowance (UTC); `false`, and nothing counted, once
   * `limit` calls were made today. Keeps the backend inside Workers AI's free daily allowance.
   */
  async takeAiCall(limit: number): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10)
    const sql = this.ctx.storage.sql
    const used = sql.exec<{ calls: number }>('SELECT calls FROM ai_calls WHERE day = ?', day).toArray()[0]?.calls ?? 0
    if (used >= limit) return false
    sql.exec('INSERT OR REPLACE INTO ai_calls (day, calls) VALUES (?, ?)', day, used + 1)
    sql.exec('DELETE FROM ai_calls WHERE day < ?', day)
    return true
  }
}
