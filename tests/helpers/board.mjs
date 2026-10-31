// Boards live in sqlite now (extensions/db.ts). A test that seeds a JSON file directly
// still passes while the server reads a different store, so seeding has to go through
// the same writer the server uses.
//
// The module is injected, not imported here: importing kanban.ts from this file would
// load it BEFORE the test swaps process.env.HOME, so it would open the real ~/.pi/kanban
// database instead of the test's temp one.
let api = null;

/** Bind the module the test already loaded (after it swapped HOME). */
export const useKanban = (m) => {
	api = m;
};

const need = () => {
	if (api === null) throw new Error("board.mjs: call useKanban(mod) after loading kanban.ts");
	return api;
};

/** Seed a board exactly as the server would. Throws instead of hiding a write failure. */
export const seedBoard = (path, b) => {
	const err = need().writeBoard(path, b);
	if (err !== null) throw new Error(err);
};

/** Read a board back through the same path the server uses. */
export const readBoardAt = (path) => need().readBoard(path);

/** Drop a board the way a fresh install would not have it. */
export const removeBoard = (path) => need().deleteBoardPath(path);

/** True when a board row was ever written (readBoard() would fake an empty one). */
export const boardExists = (path) => need().readBoardOrNull(path) !== null;
