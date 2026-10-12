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

/**
 * Temp-file paths handed in by `execute` so statements that share the command's
 * stdout but must stay *outside* the projection window can be hoisted into a
 * side channel (see CONTEXT.md → **Hoisted Statement**).
 *
 * Hoisting is never attempted when no sinks are provided: those commands are
 * left completely untouched, exactly as before side channels existed.
 */
export interface SideChannelSinks {
  /** Collects hoisted statements that run before the projection window. */
  prefix: string;
  /** Collects hoisted statements that run after the projection window. */
  suffix: string;
}

export interface StripResult {
  /**
   * The user's command with the trailing view extractor removed. This is the
   * logical, sink-free command recorded in `details.piToolGuard.cleanedCommand`.
   */
  cleaned: string;
  /**
   * What `execute` actually runs. Identical to `cleaned` when nothing had to be
   * hoisted; otherwise hoisted statements are wrapped so their stdout+stderr is
   * appended to the side-channel sinks.
   */
  execCommand: string;
  removedNames: string[];
  removedPipeline: string;
  /** Text of hoisted statements, in execution order, before the projection window. */
  hoistedPrefix: string[];
  /** Text of hoisted statements, in execution order, after the projection window. */
  hoistedSuffix: string[];
  /**
   * True when at least one statement runs after the projection window (hoisted
   * or provably silent). The shell's exit status is then the *following*
   * statement's, not the pipeline's, so a non-zero extractor exit must not be
   * reported as a failed command: `a | grep x; echo done` exits 0 in bash.
   */
  hasFollowingStatement: boolean;
}

/**
 * Commands that provably write nothing to stdout when run as a statement.
 * Deliberately tiny: `export`, `set`, `declare`, `local`, `umask`, and `hash`
 * all print their state when invoked with no arguments, so they are NOT silent
 * in general.
 */
const SILENT_COMMANDS = new Set(["cd", "true", ":", "test", "["]);

interface Range {
  start: number;
  end: number;
}

interface Edit extends Range {
  replacement: string;
}

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
 * stdout, so it may be kept in front of a stripped pipeline *without* being
 * hoisted into a side channel. Anything grouped (`(...)`, `{ ...; }`) or
 * backgrounded is never assumed silent.
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
 * True when `node` contains a pipeline ending in an extractor command. Such a
 * statement is never hoisted: the shell would run the extractor while the guard
 * manages the command's own extractor, so the result would mix a projected view
 * with a full view. Refusing keeps the outcome predictable (the whole command
 * is passed through untouched).
 */
function containsExtractorPipeline(node: unknown, seen: Set<unknown> = new Set()): boolean {
  if (node === null || typeof node !== "object") return false;
  if (seen.has(node)) return false;
  seen.add(node);

  const record = node as Record<string, unknown>;
  if (record.type === "Pipeline" && Array.isArray(record.commands)) {
    const last = record.commands[record.commands.length - 1] as
      | { type?: string; name?: { text?: string } }
      | undefined;
    const name = last?.name?.text;
    if (last?.type === "Command" && name !== undefined && isExtractor(name)) return true;
  }

  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      if (value.some((entry) => containsExtractorPipeline(entry, seen))) return true;
    } else if (containsExtractorPipeline(value, seen)) {
      return true;
    }
  }
  return false;
}

/** `'...'` quoting so a sink path can never be re-parsed by the shell. */
function quoteShell(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap a hoisted statement so its stdout+stderr is appended to `sink` instead
 * of the command's stdout.
 *
 * A newline — not `;` — terminates the group: the original text may end in a
 * `#` comment, and `;` would land inside that comment. `{ ...; }` runs in the
 * *current* shell (unlike `( ... )`), so a hoisted `cd`/assignment keeps its
 * effect on the projection window after it, and a leading redirection does not
 * reset `$?` — `{ echo "R=$?"; } >> f` still prints the previous command's
 * status.
 */
function wrapHoisted(text: string, sink: string): string {
  return `{ ${text}\n} >> ${quoteShell(sink)} 2>&1`;
}

/** Apply non-overlapping edits (sorted by `start`) to `command`. */
function spliceCommand(command: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor) continue; // defensive: never re-emit consumed text
    out += command.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return out + command.slice(cursor);
}

/**
 * Everything the guard needs to strip one command: which span to delete, and
 * which statements around it must be hoisted out of the projection window.
 */
interface ProjectionPlan {
  prefix: Range[];
  suffix: Range[];
  /** ` | tail -12` — removed from the executed command. */
  extractor: Range;
  removedNames: string[];
  removedPipeline: string;
  hoistedPrefix: string[];
  hoistedSuffix: string[];
  hasFollowingStatement: boolean;
}

/**
 * Reads of the *previous* command's status. A statement that runs after the
 * projection window and reads one of these would see the cleaned pipeline's
 * status instead of the removed extractor's, so the command is left untouched:
 *
 * ```
 * printf 'a\n' | grep nomatch; echo "R=$?"   # bash prints R=1
 * printf 'a\n';              echo "R=$?"   # guard would print R=0
 * ```
 *
 * Only the removed view's status changes, and only for statements after the
 * window — a prefix reads the status of whatever ran before it, which the guard
 * never touches.
 */
const READ_STATUS_RE = /\$\{?\?|PIPESTATUS/;

function isHoistable(command: string, node: Node): boolean {
  // `background` only exists on a Statement; an AndOr member is backgrounded by
  // its enclosing statement, which is checked when the statement is visited.
  if (node.type === "Statement" && node.background === true) return false;
  // A hoisted statement is spliced back into the command text; a here-document
  // body lives outside the statement's span, so wrapping it would cut the body
  // away from its `<<EOF`.
  if (command.slice(node.pos, node.end).includes("<<")) return false;
  return !containsExtractorPipeline(node);
}

/**
 * Try to treat `stmts[targetIndex]` as the projection window: an AndOr chain
 * whose final member is a pipeline ending in view extractors, with every other
 * statement around it either provably silent or hoistable.
 */
function planTargetAt(
  command: string,
  stmts: Node[],
  targetIndex: number,
): ProjectionPlan | undefined {
  const stmt = stmts[targetIndex];
  if (!stmt || stmt.type !== "Statement" || stmt.background === true) return undefined;

  // Walk into AndOr → Pipeline, collecting the AndOr members that run before
  // the final pipeline (`cd x && npm test | tail`).
  const members: Node[] = [];
  let inner: Node | undefined = stmt.command;
  while (inner && inner.type === "AndOr") {
    const list: Node[] = inner.commands;
    const lastCmd: Node | undefined = list[list.length - 1];
    if (!lastCmd) return undefined;
    members.push(...list.slice(0, -1));
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

  // F7: a transform extractor in the trailing pipeline means we must not
  // strip anything — the shell needs to apply the transformation.
  if (removedNames.some((name) => TRANSFORM_EXTRACTORS.has(name))) {
    return undefined;
  }

  const prevCmd = cmds[stripFrom - 1]!;
  if (!prevCmd) return undefined;

  const extractor: Range = { start: prevCmd.end, end: cmds[cmds.length - 1]!.end };

  // Every other statement shares the final pipeline's stdout, so it has to be
  // either provably silent or hoisted — anything else cannot be handled
  // faithfully, so the command is left completely untouched.
  const prefix: Range[] = [];
  for (const earlier of stmts.slice(0, targetIndex)) {
    if (isSilentPrefix(earlier)) continue;
    if (!isHoistable(command, earlier)) return undefined;
    prefix.push({ start: earlier.pos, end: earlier.end });
  }
  for (const member of members) {
    if (isSilentPrefix(member)) continue;
    if (!isHoistable(command, member)) return undefined;
    prefix.push({ start: member.pos, end: member.end });
  }

  const suffix: Range[] = [];
  const following = stmts.slice(targetIndex + 1);
  for (const later of following) {
    const text = command.slice(later.pos, later.end);
    // Stripping the extractor changes `$?` for everything after the window, and
    // the guard cannot reproduce the removed view's status (it only learns it
    // after the command has already run). Refuse rather than print a lie.
    if (READ_STATUS_RE.test(text)) return undefined;
    // A provably silent statement writes nothing to stdout, so it can stay in
    // place — it still owns the shell's exit status, which is why the plan
    // records `hasFollowingStatement` either way.
    if (isSilentPrefix(later)) continue;
    if (!isHoistable(command, later)) return undefined;
    suffix.push({ start: later.pos, end: later.end });
  }

  // Reconstruct the removed pipeline part (e.g. "grep FAIL | head -5")
  const removedPipeline = cmds
    .slice(stripFrom)
    .map((c: { pos: number; end: number }) => command.slice(c.pos, c.end))
    .join(" | ");

  return {
    prefix,
    suffix,
    extractor,
    removedNames,
    removedPipeline,
    hoistedPrefix: prefix.map((r) => command.slice(r.start, r.end)),
    hoistedSuffix: suffix.map((r) => command.slice(r.start, r.end)),
    hasFollowingStatement: following.length > 0,
  };
}

/**
 * Parse a bash command, find trailing extractor commands in the eligible
 * pipeline, strip them, and return the cleaned command + removed pipeline
 * segments. Returns undefined if nothing was changed.
 *
 * Only one pipeline can be the command's projection window: the trailing view's
 * stdout has to be the whole script's stdout. Statements that write to stdout
 * *around* that pipeline (`cd x && echo "=== build ===" && npm test | tail -12;
 * echo "TSCHECK=$?"`) are tolerated by being **hoisted** into a side channel:
 * the shell appends their stdout+stderr to a temp file, the guard appends that
 * text back around the projection, and `$?`/exit codes/`cd` effects stay exactly
 * as the shell would have produced them. Hoisting needs sinks; when
 * `stripTrailingExtractors` is called without them (or a statement cannot be
 * hoisted faithfully) the command is left completely untouched.
 *
 * F7: if any removed extractor is a "transform" (sed/awk/cut/sort/...), the
 * command is left completely untouched — stripping a transform would silently
 * drop the transformation the user asked for.
 */
export function stripTrailingExtractors(
  command: string,
  sinks?: SideChannelSinks,
): StripResult | undefined {
  let ast;
  try {
    ast = parse(command);
  } catch {
    return undefined;
  }

  const stmts: Node[] = ast.commands;
  if (stmts.length === 0) return undefined;

  // The eligible window is the *last* statement that is a strippable pipeline.
  // Everything after it is hoisted, so earlier candidates are only tried when a
  // later one cannot be handled faithfully.
  let plan: ProjectionPlan | undefined;
  for (let i = stmts.length - 1; i >= 0 && !plan; i--) {
    plan = planTargetAt(command, stmts, i);
  }
  if (!plan) return undefined;

  const {
    prefix,
    suffix,
    extractor,
    removedNames,
    removedPipeline,
    hoistedPrefix,
    hoistedSuffix,
    hasFollowingStatement,
  } = plan;

  // Without sinks a hoist would silently drop output, so such commands stay
  // untouched — this is what keeps the pre-hoisting behaviour byte-identical.
  if (prefix.length + suffix.length > 0 && !sinks) return undefined;

  const cleaned = spliceCommand(command, [{ ...extractor, replacement: "" }]).trim();
  if (!cleaned) return undefined;

  const execCommand = sinks
    ? spliceCommand(command, [
        ...prefix.map((r) => ({
          ...r,
          replacement: wrapHoisted(command.slice(r.start, r.end), sinks.prefix),
        })),
        ...suffix.map((r) => ({
          ...r,
          replacement: wrapHoisted(command.slice(r.start, r.end), sinks.suffix),
        })),
        { ...extractor, replacement: "" },
      ])
    : cleaned;

  return {
    cleaned,
    execCommand,
    removedNames,
    removedPipeline,
    hoistedPrefix,
    hoistedSuffix,
    hasFollowingStatement,
  };
}

/**
 * Extract "Full output: <path>" from bash result text.
 */
export function extractFullOutputPath(text: string): string | undefined {
  const match = text.match(/\bFull output:\s*(\S+?)\]?$/m);
  return match?.[1];
}
