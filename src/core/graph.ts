// Layered layout for the dependency map: x = layer (longest chain of blockers behind a
// card), which is exactly the order the cards can actually be worked in.
import type { Card, ColumnDef, GraphEdge, GraphLayout, GraphNode } from "../shared/dto.js";
import type { Dependency } from "./dependency.js";

export interface GraphInput {
  cards: readonly Card[];
  deps: readonly Dependency[];
  columns?: readonly ColumnDef[];
}

/**
 * Longest-path layering over "blocks" edges. Cycles cannot be created through the API
 * (assertDependencyAddable), but a hand-edited DB could hold one: the relaxation loop is
 * bounded by the node count, so a cycle degrades to "stuck at its current layer" instead
 * of hanging.
 */
export function graphLayout(input: GraphInput): GraphLayout {
  const ids = new Set(input.cards.map(c => c.id));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const incoming = new Map<number, number[]>();
  for (const d of input.deps) {
    if (d.type !== "blocks") continue;
    if (!ids.has(d.fromCard) || !ids.has(d.toCard)) continue;
    const key = `${d.fromCard}>${d.toCard}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: d.fromCard, to: d.toCard });
    const list = incoming.get(d.toCard);
    if (list) list.push(d.fromCard);
    else incoming.set(d.toCard, [d.fromCard]);
  }

  const layer = new Map<number, number>();
  for (const c of input.cards) layer.set(c.id, 0);
  for (let pass = 0; pass < input.cards.length + 1; pass++) {
    let changed = false;
    for (const e of edges) {
      const next = (layer.get(e.from) ?? 0) + 1;
      if ((layer.get(e.to) ?? 0) < next) {
        layer.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const closed = new Set(input.cards.filter(c => c.closedAt !== null && c.closedAt !== undefined).map(c => c.id));
  const blockersOpen = new Set<number>();
  for (const e of edges) if (!closed.has(e.from)) blockersOpen.add(e.to);

  const nodes: GraphNode[] = input.cards.map(c => ({
    id: c.id, columnId: c.columnId, layer: layer.get(c.id) ?? 0,
    closed: closed.has(c.id), blocked: blockersOpen.has(c.id) || Boolean(c.blockedReason), title: c.title,
  })).sort((a, b) => a.layer - b.layer || a.id - b.id);

  const layers = nodes.reduce((m, n) => Math.max(m, n.layer), -1) + 1;
  void input.columns;
  return { nodes, edges, layers };
}
