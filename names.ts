// ---------------------------------------------------------------------------
// tool-name repair: a call that names a tool pi does not have
// ---------------------------------------------------------------------------
//
// Pi resolves a tool call by exact name (`prepareToolCall`:
// `tools.find(t => t.name === toolCall.name)`) and, on a miss, returns
// `Tool <name> not found` **before** `prepareArguments`, the `tool_call` event,
// and the `tool_result` event run. So argument repair (see ./aliases.ts) never
// sees a misspelled *name*: the call is finalized as an error without any hook
// firing. The typo observed in the wild is `codememode` for `codemode` — valid
// arguments, unparsable tool.
//
// `message_end` is the last hook that runs before the tool batch is dispatched,
// and pi folds the message a handler returns onto the finalized assistant
// message in place (`_replaceMessageInPlace`), so the very object the agent
// loop filters tool calls out of. Renaming a call there therefore decides which
// tool executes, not just what the transcript shows.
//
// The rewrite budget is deliberately small, because a wrong rewrite runs the
// wrong tool while an unrewritten typo only costs one round trip:
//
//   * an exact name and a case-only variant are free,
//   * a curated alias (`TOOL_NAME_ALIASES`) is free,
//   * otherwise the edit distance must be 1, or 2 for names of at least 8
//     characters, with the first and last character unchanged,
//   * the closest declared name must be unique, and
//   * a rewrite never crosses an MCP-family boundary (`mcp__jira__…`).

export type ToolNameRepairKind =
  /** The name only differed in case (`Read` → `read`). */
  | "case"
  /** The name is a curated `TOOL_NAME_ALIASES` entry (`codememode` → `codemode`). */
  | "alias"
  /** The name was within the edit-distance budget of exactly one declared tool. */
  | "distance";

export interface ToolNameRepair {
  readonly from: string;
  readonly to: string;
  readonly kind: ToolNameRepairKind;
  /** Edit distance from `from` to `to`. `0` for `case` and `alias` repairs. */
  readonly distance: number;
}

/**
 * Curated name typos, keyed by what the model writes. A key only applies when
 * its target is a declared tool; the alias is preferred over the edit-distance
 * search so a known typo always resolves to the same tool.
 */
export const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  // Observed in a real pi session: the model wrote `codememode` with perfectly
  // valid `{ code }` arguments and got `Tool codememode not found`.
  codememode: "codemode",
};

/** Declared names shorter than this are never rewrite targets. */
const MIN_TARGET_LENGTH = 4;
/** Names at least this long get an edit-distance budget of 2 instead of 1. */
const LONG_NAME_LENGTH = 8;
const SHORT_BUDGET = 1;
const LONG_BUDGET = 2;
const NAMESPACE_SEPARATOR = "__";

/**
 * Minimal structural view of a message: enough to find `toolCall` content
 * parts without depending on the agent-core message unions, which are shared by
 * every extension and version-sensitive.
 */
export interface ToolCallMessageLike {
  readonly role?: unknown;
  readonly content?: unknown;
}

export interface ToolCallNameRepair<T> {
  /** The message to hand back to pi. Identical to the input when nothing changed. */
  readonly message: T;
  readonly repairs: readonly ToolNameRepair[];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isToolCallPart = (value: unknown): value is { type: "toolCall"; name: string } =>
  isRecord(value) && value.type === "toolCall" && typeof value.name === "string";

/** The segment before the last `__`, or `undefined` for a flat tool name. */
function familyOf(name: string): string | undefined {
  const at = name.lastIndexOf(NAMESPACE_SEPARATOR);
  return at === -1 ? undefined : name.slice(0, at).toLowerCase();
}

/**
 * True when `from` and `to` live in the same MCP family, or when neither of
 * them is namespaced. A rewrite never crosses a family: `mcp__jria__x` stays
 * unrepaired even though `mcp__jira__x` is two edits away.
 */
function sameFamily(from: string, to: string): boolean {
  const fromFamily = familyOf(from);
  const toFamily = familyOf(to);
  if (fromFamily === undefined && toFamily === undefined) return true;
  return fromFamily === toFamily;
}

/**
 * A distance of 2 is only plausible when the ends are untouched — `codememode`
 * keeps the leading `c` and the trailing `e` of `codemode`, while an unrelated
 * name rarely shares both.
 */
function endsMatch(from: string, to: string): boolean {
  const a = from.toLowerCase();
  const b = to.toLowerCase();
  return a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
}

/**
 * Restricted Damerau-Levenshtein distance (insertion, deletion, substitution,
 * adjacent transposition), abandoned as soon as every path in a row exceeds
 * `max` — which is what keeps the per-call cost negligible.
 */
export function editDistance(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  const lengthGap = Math.abs(a.length - b.length);
  if (lengthGap > max) return max + 1;

  let beforePrevious: number[] = [];
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, column) => column);

  for (let row = 1; row <= a.length; row++) {
    const current: number[] = [row];
    let rowMinimum = row;
    for (let column = 1; column <= b.length; column++) {
      const substitution = a[row - 1] === b[column - 1] ? 0 : 1;
      let value = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + substitution,
      );
      if (
        row > 1 &&
        column > 1 &&
        a[row - 1] === b[column - 2] &&
        a[row - 2] === b[column - 1]
      ) {
        value = Math.min(value, beforePrevious[column - 2] + 1);
      }
      current[column] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > max) return max + 1;
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

/** The closest declared name, when it is unique and inside the budget. */
function nearestDeclaredName(
  name: string,
  declared: readonly string[],
): ToolNameRepair | undefined {
  const budget = name.length >= LONG_NAME_LENGTH ? LONG_BUDGET : SHORT_BUDGET;
  let best: { candidate: string; distance: number } | undefined;
  let ambiguous = false;

  for (const candidate of declared) {
    if (candidate.length < MIN_TARGET_LENGTH) continue;
    if (!sameFamily(name, candidate)) continue;
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase(), budget);
    if (distance === 0 || distance > budget) continue;
    if (distance > 1 && !endsMatch(name, candidate)) continue;

    if (best === undefined || distance < best.distance) {
      best = { candidate, distance };
      ambiguous = false;
    } else if (distance === best.distance) {
      ambiguous = true;
    }
  }

  if (best === undefined || ambiguous) return undefined;
  return { from: name, to: best.candidate, kind: "distance", distance: best.distance };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * The repair for one tool name, or `undefined` when the name is either declared
 * already or has no safe rewrite.
 */
export function repairToolName(
  name: string,
  declared: readonly string[],
  aliases: Readonly<Record<string, string | undefined>> = TOOL_NAME_ALIASES,
): ToolNameRepair | undefined {
  if (declared.includes(name)) return undefined;

  const lowercased = name.toLowerCase();
  const caseMatch = declared.find((candidate) => candidate.toLowerCase() === lowercased);
  if (caseMatch !== undefined) return { from: name, to: caseMatch, kind: "case", distance: 0 };

  const alias = aliases[name] ?? aliases[lowercased];
  if (alias !== undefined && declared.includes(alias)) {
    return { from: name, to: alias, kind: "alias", distance: 0 };
  }

  return nearestDeclaredName(name, declared);
}

/**
 * Rename every misspelled `toolCall` in an assistant message to the tool the
 * model meant. The input message is never mutated: a repaired message is a
 * shallow copy with a new `content` array, and only the renamed parts are
 * copied, so thinking/text parts and untouched calls stay identical.
 */
export function repairToolCallNames<T extends ToolCallMessageLike>(
  message: T,
  declared: readonly string[],
  aliases: Readonly<Record<string, string | undefined>> = TOOL_NAME_ALIASES,
): ToolCallNameRepair<T> {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return { message, repairs: [] };
  }

  const content = message.content;
  let repairedContent: unknown[] | undefined;
  const repairs: ToolNameRepair[] = [];

  for (let index = 0; index < content.length; index++) {
    const part: unknown = content[index];
    if (!isToolCallPart(part)) continue;

    const repair = repairToolName(part.name, declared, aliases);
    if (repair === undefined) continue;

    repairedContent ??= [...content];
    repairedContent[index] = { ...part, name: repair.to };
    repairs.push(repair);
  }

  if (repairedContent === undefined) return { message, repairs };
  return { message: { ...message, content: repairedContent } as T, repairs };
}