import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type BashToolInput,
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
import { executeBashGuarded, prepareBashArguments } from "./execute.ts";

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function toolGuardExtension(pi: ExtensionAPI) {
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
    const bashDef = createBashToolDefinition(ctx.cwd);
    const originalExecute = bashDef.execute;

    pi.registerTool({
      ...bashDef,
      prepareArguments: (args: unknown): BashToolInput => {
        if (!args || typeof args !== "object") return args as BashToolInput;
        return prepareBashArguments(args as Record<string, unknown>) as unknown as BashToolInput;
      },

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
    });

    ctx.ui.notify("pi-tool-guard: overriding edit/write/read/bash with corrections", "info");
  });
}
