// The extension runs migrateScopeOnce() at startup (phase 0: session/global boards fold
// into project boards). A test seeds the OLD layout, so it must settle the migration
// first - otherwise startup eats the boards it just seeded.
let api = null;
export const useMigrate = (m) => {
	api = m;
};
export const settleMigration = async () => {
	if (api === null) throw new Error("migrate.mjs: call useMigrate(mod) after loading kanban.ts");
	await api.migrateScopeOnce();
};
