export const PORT_DEFAULT = 8789;
export const HOST_DEFAULT = "0.0.0.0";
export const TOKEN_COOKIE = "kb_auth";
export const TOKEN_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
export const KANBAN_DIR_NAME = "kanban";
export const DB_FILE = "state.sqlite";
export const SCHEMA_VERSION = 1;
export const BUILD_META_KEY = "build";
/**
 * A card in a doing-kind column with no move for this long is stale (v1 showed `⚠3h` in the TUI
 * footer). One home for the number: the web has no stale notion yet and must adopt this, not
 * invent a second threshold.
 */
export const STALE_DOING_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_COLUMNS = [
  { id: "todo", name: "TODO", kind: "todo", ord: 0 },
  { id: "doing", name: "DOING", kind: "doing", ord: 1 },
  { id: "done", name: "DONE", kind: "done", ord: 2 },
] as const;
