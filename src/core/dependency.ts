// Dependency edges + cycle detection. Only "blocks" edges form the DAG used for cycles
// and readiness; "relates" is an undirected association and never constrains anything.
import type { Card } from "../shared/dto.js";
import type { EntityId, ProjectId } from "../shared/ids.js";
import { assertId, domainError, invalid } from "./validation.js";

export type DependencyType = "blocks" | "relates";
export const DEPENDENCY_TYPES = ["blocks", "relates"] as const;

/** `fromCard` blocks `toCard` (type "blocks"). */
export interface Dependency {
  projectId: ProjectId;
  fromCard: EntityId;
  toCard: EntityId;
  type: DependencyType;
}

export function assertDependencyType(v: unknown): DependencyType {
  if (typeof v !== "string" || !(DEPENDENCY_TYPES as readonly string[]).includes(v)) {
    throw invalid(`dependency type must be one of ${DEPENDENCY_TYPES.join("|")}`, { type: v });
  }
  return v as DependencyType;
}

export function makeDependency(projectId: ProjectId, fromCard: EntityId, toCard: EntityId, type: DependencyType = "blocks"): Dependency {
  return { projectId, fromCard: assertId(fromCard, "fromCard"), toCard: assertId(toCard, "toCard"), type: assertDependencyType(type) };
}

export function hasDependency(deps: readonly Dependency[], fromCard: EntityId, toCard: EntityId, type: DependencyType = "blocks"): boolean {
  return deps.some(d => d.fromCard === fromCard && d.toCard === toCard && d.type === type);
}

function blocksAdjacency(deps: readonly Dependency[]): Map<EntityId, EntityId[]> {
  const adj = new Map<EntityId, EntityId[]>();
  for (const d of deps) {
    if (d.type !== "blocks") continue;
    const list = adj.get(d.fromCard);
    if (list) list.push(d.toCard);
    else adj.set(d.fromCard, [d.toCard]);
  }
  return adj;
}

function reachableFrom(adj: Map<EntityId, EntityId[]>, start: EntityId): Set<EntityId> {
  const seen = new Set<EntityId>();
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop() as EntityId;
    for (const next of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen;
}

/**
 * Would adding `fromCard -> toCard` close a loop? True for a self edge, and true when
 * `toCard` already (transitively) blocks `fromCard`.
 */
export function wouldCreateCycle(deps: readonly Dependency[], fromCard: EntityId, toCard: EntityId, type: DependencyType = "blocks"): boolean {
  if (type !== "blocks") return false;
  if (fromCard === toCard) return true;
  if (hasDependency(deps, toCard, fromCard, "blocks")) return true;
  return reachableFrom(blocksAdjacency(deps), toCard).has(fromCard);
}

/** Full edge validation in one place: self edge, duplicate, then cycle. */
export function assertDependencyAddable(deps: readonly Dependency[], fromCard: EntityId, toCard: EntityId, type: DependencyType = "blocks"): void {
  if (fromCard === toCard) throw invalid("a card cannot depend on itself", { id: fromCard });
  if (hasDependency(deps, fromCard, toCard, type)) {
    throw domainError("CONFLICT", `dependency ${fromCard} ${type} ${toCard} already exists`, { fromCard, toCard, type });
  }
  if (wouldCreateCycle(deps, fromCard, toCard, type)) {
    throw domainError("CYCLE", `dependency ${fromCard} -> ${toCard} would create a cycle`, { fromCard, toCard });
  }
}

/** Cards that block `cardId` (incoming "blocks" edges), ascending and de-duplicated. */
export function blockersOf(deps: readonly Dependency[], cardId: EntityId): EntityId[] {
  const out = new Set<EntityId>();
  for (const d of deps) if (d.type === "blocks" && d.toCard === cardId) out.add(d.fromCard);
  return [...out].sort((a, b) => a - b);
}

/** Cards blocked by `cardId` (outgoing "blocks" edges), ascending and de-duplicated. */
export function blocksOf(deps: readonly Dependency[], cardId: EntityId): EntityId[] {
  const out = new Set<EntityId>();
  for (const d of deps) if (d.type === "blocks" && d.fromCard === cardId) out.add(d.toCard);
  return [...out].sort((a, b) => a - b);
}

/** Completion lookup over a card list (a card is "done" once it has `closedAt`). */
export function closedLookup(cards: readonly Pick<Card, "id" | "closedAt">[]): (id: EntityId) => boolean {
  const closed = new Set<EntityId>();
  for (const c of cards) if (c.closedAt !== null && c.closedAt !== undefined) closed.add(c.id);
  return (id: EntityId) => closed.has(id);
}

/** Blockers of `cardId` that are not done yet — the ones that actually block. */
export function openBlockersOf(deps: readonly Dependency[], cardId: EntityId, isDone: (id: EntityId) => boolean): EntityId[] {
  return blockersOf(deps, cardId).filter(id => !isDone(id));
}

export function isDependencyBlocked(deps: readonly Dependency[], cardId: EntityId, isDone: (id: EntityId) => boolean): boolean {
  return openBlockersOf(deps, cardId, isDone).length > 0;
}

/** Kahn topological order over "blocks" edges; throws CYCLE if the graph is already cyclic. */
export function topoOrder(deps: readonly Dependency[], ids: readonly EntityId[]): EntityId[] {
  const nodes = [...new Set(ids)].sort((a, b) => a - b);
  const indeg = new Map<EntityId, number>(nodes.map(id => [id, 0]));
  const adj = blocksAdjacency(deps);
  for (const id of nodes) {
    for (const next of adj.get(id) ?? []) {
      if (indeg.has(next)) indeg.set(next, (indeg.get(next) as number) + 1);
    }
  }
  const queue = nodes.filter(id => indeg.get(id) === 0);
  const out: EntityId[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as EntityId;
    out.push(id);
    for (const next of adj.get(id) ?? []) {
      if (!indeg.has(next)) continue;
      const left = (indeg.get(next) as number) - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (out.length !== nodes.length) throw domainError("CYCLE", "dependency graph contains a cycle", { ids: nodes.filter(id => !out.includes(id)) });
  return out;
}
