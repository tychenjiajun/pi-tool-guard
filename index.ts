import type { ExtensionAPI, AgentToolResult, BashToolDetails } from "@earendil-works/pi-coding-agent";
import {
  type EditToolInput,
  type ReadToolInput,
  type WriteToolInput,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  normalizeEditArgs,
  normalizeWriteArgs,
  normalizeReadArgs,
} from "./aliases.ts";
import { executeBashGuarded } from "./execute.ts";
import { readPiToolGuardDetails } from "./contract.ts";
import { repairToolCallNames } from "./names.ts";
import { applyGuardReceipt, shouldRenderGuardReceipt, type ChildContainer } from "./render.ts";

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function toolGuardExtension(pi: ExtensionAPI) {
  // ── Repair tool *names* before the batch is dispatched ────────────────
  // A misspelled tool name never reaches `prepareArguments` or `tool_call`:
  // pi resolves the name first and finalizes `Tool <name> not found` without
  // running a hook. `message_end` is the last point before dispatch, and pi
  // folds the returned message onto the very assistant message the loop reads
  // tool calls from, so a rename here decides what executes.
  pi.on("message_end", async (event, ctx) => {
    const message: { role?: unknown } = event.message;
    if (message.role !== "assistant") return;

    const { message: repaired, repairs } = repairToolCallNames(
      event.message,
      pi.getActiveTools(),
    );
    if (repairs.length === 0) return;

    for (const repair of repairs) {
      ctx.ui.notify(
        `pi-tool-guard: repaired tool call "${repair.from}" → "${repair.to}"`,
        "warning",
      );
    }
    return { message: repaired };
  });

  pi.on("session_start", async (_event, ctx) => {
    // ── Override edit ──────────────────────────────────────────────────
    pi.registerTool({
      ...createEditToolDefinition(ctx.cwd),
      prepareArguments: (args: unknown): EditToolInput => {
        if (args && typeof args === "object") {
          normalizeEditArgs(args as Record<string, unknown>);
        }
        return args as EditToolInput;
      },
    });

    // ── Override write ─────────────────────────────────────────────────
    pi.registerTool({
      ...createWriteToolDefinition(ctx.cwd),
      prepareArguments: (args: unknown): WriteToolInput => {
        if (args && typeof args === "object") {
          normalizeWriteArgs(args as Record<string, unknown>);
        }
        return args as WriteToolInput;
      },
    });

    // ── Override read ──────────────────────────────────────────────────
    pi.registerTool({
      ...createReadToolDefinition(ctx.cwd),
      prepareArguments: (args: unknown): ReadToolInput => {
        if (args && typeof args === "object") {
          normalizeReadArgs(args as Record<string, unknown>);
        }
        return args as ReadToolInput;
      },
    });

    // ── Override bash ──────────────────────────────────────────────────
    // Extractor stripping happens inside `execute` (not `prepareArguments`)
    // so `tool_result.input.command` keeps the command the user wrote. See
    // ./contract.ts for the details.piToolGuard record published downstream.
    const bashDef = createBashToolDefinition(ctx.cwd);
    const originalExecute = bashDef.execute;
    const originalRenderResult = bashDef.renderResult;

    pi.registerTool({
      ...bashDef,
      async execute(toolCallId, params, signal, onUpdate, execCtx) {
        return executeBashGuarded(
          { pi, ctx, originalExecute },
          toolCallId,
          params,
          signal,
          onUpdate,
          execCtx,
        );
      },
      // When the guard projected a slow command it ran an extra extractor
      // afterwards. Pi's built-in renderer still prints one opaque
      // `Took <total>` line, so replace it with a SoL-Pi-style guard receipt.
      // Fast commands and no-op projections show nothing — pi's plain `Took`
      // line stays.
      renderResult(result, options, theme, context) {
        const renderOriginal = originalRenderResult as NonNullable<typeof originalRenderResult>;
        const component = renderOriginal(
          result as AgentToolResult<BashToolDetails | undefined>,
          options,
          theme,
          context,
        );
        if (options.isPartial) return component;

        const guard = readPiToolGuardDetails(result.details);
        // Fast commands stay visually identical to the built-in bash tool: no
        // guard Notice and no receipt. Only a slow run justifies the extra UI.
        if (!shouldRenderGuardReceipt(guard)) return component;

        applyGuardReceipt(
          component as unknown as ChildContainer,
          theme,
          guard!,
          guard!.timing!,
          // Pi's renderer prints its `Took` line when it has a recorded
          // durationMs (survives session reloads, pi >= 1.1.0) or a live
          // startedAt clock; only then is the trailing child safe to drop.
          context.durationMs !== undefined || context.state?.startedAt !== undefined,
        );
        return component;
      },
    });

    ctx.ui.notify(
      "pi-tool-guard: overriding edit/write/read/bash with corrections, repairing tool names",
      "info",
    );
  });
}
