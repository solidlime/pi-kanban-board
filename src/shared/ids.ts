// v2 composite IDs: (projectId, entityId). Never resolve by bare entityId.
export type ProjectId = string; // slug
export type EntityId = number;  // project-local sequence (>=1)

export interface CompositeId { projectId: ProjectId; id: EntityId }

export function cid(projectId: ProjectId, id: EntityId): CompositeId {
  if (!projectId || typeof projectId !== "string") throw new Error("invalid projectId");
  if (!Number.isInteger(id) || id < 1) throw new Error("invalid id");
  return { projectId, id };
}

export function formatCid(c: CompositeId): string { return `${c.projectId}#${c.id}`; }

export function parseCid(s: string): CompositeId {
  const i = s.lastIndexOf("#");
  if (i <= 0) throw new Error("invalid composite id");
  const projectId = s.slice(0, i);
  const id = Number(s.slice(i + 1));
  return cid(projectId, id);
}

export function sameCid(a: CompositeId, b: CompositeId): boolean {
  return a.projectId === b.projectId && a.id === b.id;
}
