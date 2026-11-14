// A6: one writer per resource. A lock is a row with an expiry; an expired row is reclaimed
// the moment anyone looks, so a crashed holder never wedges the board for good.
import type { Db } from "./db.js";
import { all, run, withTx } from "./db.js";
import { DomainError } from "../shared/errors.js";

export interface Lock { resource: string; owner: string; at: string; expiresAt: string }

export const TTL_DEFAULT = 120;
export const TTL_MAX = 86_400;
/** Resource names are slugs a human types, not paths: keep them boring and URL-safe. */
const RESOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function assertResource(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!RESOURCE_RE.test(s)) {
    throw new DomainError("VALIDATION", "resource must be 1-64 chars of [A-Za-z0-9._:-] starting alphanumeric", { field: "resource" });
  }
  return s;
}

export function assertTtlSeconds(raw: unknown): number {
  const n = raw === undefined || raw === null ? TTL_DEFAULT : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > TTL_MAX) {
    throw new DomainError("VALIDATION", `ttlSeconds must be an integer 1..${TTL_MAX}`, { field: "ttlSeconds" });
  }
  return n;
}

function reclaim(db: Db, projectId: string, now: string): void {
  run(db, "DELETE FROM card_lock WHERE project_id = ? AND expires_at <= ?", projectId, now);
}

export function listLocks(db: Db, projectId: string, now: Date = new Date()): Lock[] {
  return withTx(db, () => {
    reclaim(db, projectId, now.toISOString());
    // Mapped to plain objects: node:sqlite hands back null-prototype rows, which are awkward
    // to compare and to spread.
    return all<Lock>(db,
      "SELECT resource, owner, at, expires_at AS expiresAt FROM card_lock WHERE project_id = ? ORDER BY resource ASC",
      projectId).map(r => ({ resource: r.resource, owner: r.owner, at: r.at, expiresAt: r.expiresAt }));
  });
}

/** Take the lock or lose with 409 LOCK_HELD; re-taking your own expired lock is fine. */
export function acquireLock(
  db: Db,
  input: { projectId: string; resource: string; owner: string; ttlSeconds?: number },
  now: Date = new Date(),
): Lock {
  const resource = assertResource(input.resource);
  const ttlSeconds = assertTtlSeconds(input.ttlSeconds);
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  return withTx(db, () => {
    reclaim(db, input.projectId, at);
    const held = all<{ owner: string; expires_at: string }>(db,
      "SELECT owner, expires_at FROM card_lock WHERE project_id = ? AND resource = ?", input.projectId, resource)[0];
    if (held) {
      throw new DomainError("CONFLICT", `resource "${resource}" is locked by ${held.owner} until ${held.expires_at}`, {
        code: "LOCK_HELD", resource, owner: held.owner, expiresAt: held.expires_at,
      });
    }
    run(db, "INSERT INTO card_lock (project_id, resource, owner, at, expires_at) VALUES (?, ?, ?, ?, ?)",
      input.projectId, resource, input.owner, at, expiresAt);
    return { resource, owner: input.owner, at, expiresAt };
  });
}

/** Release whether or not the caller owns it — a stuck lock with a known name must be clearable. */
export function releaseLock(db: Db, projectId: string, resource: string, now: Date = new Date()): boolean {
  return withTx(db, () => {
    reclaim(db, projectId, now.toISOString());
    const r = run(db, "DELETE FROM card_lock WHERE project_id = ? AND resource = ?", projectId, assertResource(resource));
    return Number(r.changes) > 0;
  });
}
