export const PORT_DEFAULT = 8789;
export const HOST_DEFAULT = "0.0.0.0";
export const TOKEN_COOKIE = "kb_auth";
export const TOKEN_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
export const KANBAN_DIR_NAME = "kanban";
export const DB_FILE = "state.sqlite";
export const SCHEMA_VERSION = 1;
export const BUILD_META_KEY = "build";
export const DEFAULT_COLUMNS = [
  { id: "todo", name: "TODO", kind: "todo", ord: 0 },
  { id: "doing", name: "DOING", kind: "doing", ord: 1 },
  { id: "done", name: "DONE", kind: "done", ord: 2 },
] as const;
