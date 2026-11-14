// Compatibility surface for v2 agent adapter (W3F). Keeps tool names/order and param semantics.
export const KANBAN_ACTIONS = ['list','add','move','remove','check','resume','url','edit','img','ref'] as const;
export const DELIVERABLE_ACTIONS = ['add','list','edit','remove','img','ref'] as const;
export const SCOPES = ['global','project'] as const;
export const COLS = ['todo','doing','done'] as const;

export type Scope = typeof SCOPES[number];
export type Col = typeof COLS[number];

export interface KanbanInput {
  action: typeof KANBAN_ACTIONS[number];
  scope?: Scope; text?: string; id?: number; col?: Col;
  nextFireAt?: string; blocked?: string | boolean;
  project?: string; session?: string; commit?: string;
  labels?: string[]; image?: string; priority?: number;
}
