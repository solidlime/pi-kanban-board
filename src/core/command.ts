// `/kanban` argv split. The host hands the whole command line as one string, so words are
// separated by runs of whitespace. Kept here, not inline in the extension, so a test can pin it:
// the inline version once read /\\s+/ — a literal backslash-escaping that never matched, which
// turned every subcommand into a card title.
export function parseCommandArgs(args: string | undefined): string[] {
  return (args ?? "").trim().split(/\s+/).filter((w) => w.length > 0);
}
