import { parse, type Node } from "unbash";

// ---------------------------------------------------------------------------
// pipeline extractor stripping (unbash AST)
// ---------------------------------------------------------------------------

export const VIEW_EXTRACTORS = new Set([
  "head",
  "tail",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "less",
  "more",
]);

export const TRANSFORM_EXTRACTORS = new Set([
  "sed",
  "awk",
  "cut",
  "sort",
  "uniq",
  "wc",
  "column",
  "jq",
  "yq",
  "tr",
]);

export type ExtractorKind = "view" | "transform";

export function classifyExtractor(name: string): ExtractorKind | undefined {
  if (VIEW_EXTRACTORS.has(name)) return "view";
  if (TRANSFORM_EXTRACTORS.has(name)) return "transform";
  return undefined;
}

// Backward-compatible union of the two sets.
export const EXTRACTOR_COMMANDS = new Set([...VIEW_EXTRACTORS, ...TRANSFORM_EXTRACTORS]);

export function isExtractor(name: string): boolean {
  return EXTRACTOR_COMMANDS.has(name);
}

export interface StripResult {
  cleaned: string;
  removedNames: string[];
  removedPipeline: string;
}

/**
 * Commands that provably write nothing to stdout when run as a statement.
 * Deliberately tiny: `export`, `set`, `declare`, `local`, `umask`, and `hash`
 * all print their state when invoked with no arguments, so they are NOT silent
 * in general.
 */
const SILENT_COMMANDS = new Set(["cd", "true", ":", "test", "["]);

/**
 * A simple command that provably writes nothing to stdout. Redirects are
 * rejected because `2>&1`/`&>` can merge stderr into the very stream the
 * extractor will read. A command with no name is an assignment (`FOO=bar`),
 * which is silent.
 */
function isSilentSimpleCommand(node: Node | undefined): boolean {
  if (!node || node.type !== "Command") return false;
  if (node.redirects.length > 0) return false;
  const name = node.name?.text;
  if (name === undefined) return true;
  return SILENT_COMMANDS.has(name);
}

/**
 * A statement/AndOr member that provably contributes nothing to the script's
 * stdout, so it may be kept in front of a stripped pipeline. Anything grouped
 * (`(...)`, `{ ...; }`) or backgrounded is never assumed silent.
 */
function isSilentPrefix(node: Node | undefined): boolean {
  if (!node) return false;
  if (node.type === "Statement") {
    if (node.background === true) return false;
    return isSilentPrefix(node.command);
  }
  if (node.type === "Command") return isSilentSimpleCommand(node);
  if (node.type === "Pipeline") {
    return node.commands.length > 0 && node.commands.every((cmd) => isSilentSimpleCommand(cmd));
  }
  return false;
}

/**
 * Parse a bash command, find trailing extractor commands in the final
 * pipeline, strip them, and return the cleaned command + removed pipeline
 * segments. Returns undefined if nothing was changed.
 *
 * Only the command's final pipeline is eligible. With `;`/`&&`/`||` the
 * stripped extractor's stdout is the whole script's stdout, so re-applying it
 * after stripping would filter the earlier statements too (e.g.
 * `a && b | head` would return the head of `a`, not of `b`). The one
 * exception is a prefix that provably writes nothing to stdout
 * (`cd x && npm test | tail`); anything else is left completely untouched.
 *
 * F7: if any removed extractor is a "transform" (sed/awk/cut/sort/...), the
 * command is left completely untouched — stripping a transform would silently
 * drop the transformation the user asked for.
 */
export function stripTrailingExtractors(command: string): StripResult | undefined {
  let ast;
  try {
    ast = parse(command);
  } catch {
    return undefined;
  }

  // Only the LAST statement can end the command. Looking at `commands[0]`
  // would treat an extractor in the middle of `a | head; b` as trailing and
  // then chop off every later statement when rebuilding `cleaned`.
  const stmt = ast.commands[ast.commands.length - 1];
  if (!stmt) return undefined;

  // A backgrounded final statement (`... | tail &`) is not synchronously
  // capturable, and slicing out its extractor would drop the trailing `&`,
  // silently converting a background job into a foreground one. Leave it be.
  if (stmt.background === true) return undefined;

  // Walk into AndOr → Pipeline, collecting the AndOr members that run before
  // the final pipeline (`cd x && npm test | tail`).
  const prefix: Node[] = [];
  let inner: Node | undefined = stmt.command;
  while (inner && inner.type === "AndOr") {
    const members: Node[] = inner.commands;
    const lastCmd: Node | undefined = members[members.length - 1];
    if (!lastCmd) return undefined;
    prefix.push(...members.slice(0, -1));
    inner = lastCmd;
  }

  if (!inner || inner.type !== "Pipeline") return undefined;

  // Every earlier top-level statement shares the final pipeline's stdout, so
  // re-applying the extractor would filter its output too. Proceed only when
  // the whole prefix is provably silent — otherwise leave the command alone.
  prefix.push(...ast.commands.slice(0, -1));
  if (!prefix.every(isSilentPrefix)) return undefined;

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

  // F7: a transform extractor in the trailing pipeline means we must not
  // strip anything — the shell needs to apply the transformation.
  if (removedNames.some((name) => TRANSFORM_EXTRACTORS.has(name))) {
    return undefined;
  }

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
