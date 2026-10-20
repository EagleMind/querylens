// The list of projects: one small Durable Object, touched only by the dashboard (never on
// the ingest path, which goes straight to each project's own object).
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
    })
  }

  async add(id: string, name: string): Promise<void> {
    this.ctx.storage.sql.exec('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)', id, name, new Date().toISOString())
  }

  async rename(id: string, name: string): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE projects SET name = ? WHERE id = ?', name, id)
  }

  async list(): Promise<ProjectEntry[]> {
    return this.ctx.storage.sql
      .exec<{ id: string; name: string; created_at: string }>('SELECT id, name, created_at FROM projects ORDER BY created_at')
      .toArray()
      .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }))
  }
}
