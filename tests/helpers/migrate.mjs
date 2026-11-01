// The extension runs resetScopesOnce() at startup (#17: every non-project board row is
// dropped and meta.scopes_reset is set). A test that seeds the old layout must settle that
// reset first - otherwise startup eats the boards it just seeded.
let api = null;
export const useMigrate = (m) => {
	api = m;
};
export const settleMigration = async () => {
	if (api === null) throw new Error("migrate.mjs: call useMigrate(mod) after loading kanban.ts");
	api.resetScopesOnce();
};
