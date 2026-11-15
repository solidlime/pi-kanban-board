import { inspectInit, planInit, executeInit, detectState, kanbanHome, type InitMode } from './persistence/init.js';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(2)} MB`;
}

export async function runInit(argv: string[]) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`usage: init [--home=<path>] [--inspect] [--confirm (--backup | --delete)]
  --inspect   report what would be created and stop (exit 2, writes nothing)
  --confirm   apply the plan; needs exactly one of --backup or --delete
  --home      target directory, must end in .pi/kanban`);
    return { ok: true, usage: true };
  }
  const homeArg = argv.find(a => a.startsWith('--home='));
  const home = homeArg ? homeArg.slice('--home='.length) : kanbanHome();
  const doBackup = argv.includes('--backup');
  const doDelete = argv.includes('--delete');
  const confirmed = argv.includes('--confirm');
  const showInspect = argv.includes('--inspect') || !confirmed;

  const state = detectState(home);
  const plan = planInit(new Date(), home);
  const inspection = inspectInit(plan);

  if (showInspect) {
    const lines = [
      `home: ${home}`,
      `state: ${state.status} (initialized=${state.initialized}, schema=${state.schemaVersion ?? 'n/a'})`,
      `existing targets: ${inspection.existing.length} (${fmtBytes(inspection.totalBytes)})`,
      ...inspection.existing.map(t => `  - ${t.name} [${t.kind}] ${fmtBytes(t.size)}`),
      `will create: ${plan.willCreate.map(p => p.replace(home, '').replace(/^[\\/]/, '')).join(', ')}`,
      `backup dir (if --backup): ${plan.backupDir}`,
    ];
    console.log(lines.join('\n'));
  }

  if (!confirmed) {
    console.log('\nRefusing: this is destructive to v1 contents. Review targets/backup path above, then re-run with --confirm and exactly one of --backup (default, recommended) or --delete.');
    return { ok: false, reason: 'confirmation_required', plan, inspection, state };
  }
  if (doBackup === doDelete) {
    // default to backup if neither specified explicitly? require explicit choice for safety
    if (!doBackup && !doDelete) throw new Error('choose --backup or --delete with --confirm');
    throw new Error('choose exactly one of --backup or --delete');
  }
  const mode: InitMode = doBackup ? 'backup' : 'delete';
  const res = executeInit(plan, { confirmed: true, mode });
  console.log(JSON.stringify({ ok: true, mode, res }, null, 2));
  return { ok: true, mode, res };
}
