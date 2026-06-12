import { parse } from "unbash";

// ---------------------------------------------------------------------------
// pipeline extractor stripping (unbash AST)
// ---------------------------------------------------------------------------

export const EXTRACTOR_COMMANDS = new Set([
  "head",
  "tail",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "sed",
  "awk",
  "cut",
  "sort",
  "uniq",
  "wc",
  "less",
  "more",
  "column",
  "jq",
  "yq",
  "tr",
]);

export function isExtractor(name: string): boolean {
  return EXTRACTOR_COMMANDS.has(name);
}

export interface StripResult {
  cleaned: string;
  removedNames: string[];
  removedPipeline: string;
}

/**
 * Parse a bash command, find trailing extractor commands in pipelines,
 * strip them, and return the cleaned command + pipeline segments.
 * Returns undefined if nothing was changed.
 */
export function stripTrailingExtractors(command: string): StripResult | undefined {
  let ast;
  try {
    ast = parse(command);
  } catch {
    return undefined;
  }

  const stmt = ast.commands[0];
  if (!stmt) return undefined;

  // Walk into AndOr → Pipeline → commands
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let inner: any = stmt.command;
  while (inner && inner.type === "AndOr") {
    const lastCmd = inner.commands[inner.commands.length - 1];
    if (!lastCmd) return undefined;
    inner = lastCmd;
  }

  if (!inner || inner.type !== "Pipeline") return undefined;

  const cmds = inner.commands;
  if (cmds.length < 2) return undefined;

  // Walk backward, collect trailing extractors
  const removedNames: string[] = [];
  let stripFrom = cmds.length;

  for (let i = cmds.length - 1; i >= 1; i--) {
    const cmd = cmds[i]!;
    if (cmd.type !== "Command") break;
    const name = cmd.name?.text;
    if (name && isExtractor(name)) {
      removedNames.unshift(name);
      stripFrom = i;
    } else {
      break;
    }
  }

  if (stripFrom === cmds.length) return undefined;

  const prevCmd = cmds[stripFrom - 1]!;
  const cleaned = command.slice(0, prevCmd.end).trim();
  if (!cleaned) return undefined;

  // Reconstruct the removed pipeline part (e.g. "grep FAIL | head -5")
  const removedPipeline = cmds
    .slice(stripFrom)
    .map((c: { pos: number; end: number }) => command.slice(c.pos, c.end))
    .join(" | ");

  return { cleaned, removedNames, removedPipeline };
}

/**
 * Extract "Full output: <path>" from bash result text.
 */
export function extractFullOutputPath(text: string): string | undefined {
  const match = text.match(/\bFull output:\s*(\S+?)\]?$/m);
  return match?.[1];
}
