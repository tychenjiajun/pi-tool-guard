import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import toolGuardExtension from "./index.ts";

// ---------------------------------------------------------------------------
// The extension has no pi runtime here: register the factory against a fake
// `pi`, then drive the handlers it registered directly. This covers the wiring
// (which event, which hook arguments, which notification) that the pure
// ./names.ts tests cannot see.
// ---------------------------------------------------------------------------

const DECLARED = ["bash", "edit", "read", "write", "codemode"];

interface Harness {
  readonly pi: ExtensionAPI;
  readonly handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  readonly notify: ReturnType<typeof vi.fn>;
  readonly getActiveTools: ReturnType<typeof vi.fn>;
}

function createHarness(declared: readonly string[] = DECLARED): Harness {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const notify = vi.fn();
  const getActiveTools = vi.fn(() => [...declared]);

  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerTool: vi.fn(),
    getActiveTools,
  } as unknown as ExtensionAPI;

  toolGuardExtension(pi);
  return { pi, handlers, notify, getActiveTools };
}

const ctx = (notify: ReturnType<typeof vi.fn>) =>
  ({ ui: { notify } }) as unknown as ExtensionContext;

const toolCall = (name: string, arguments_: unknown = { code: "1" }) => ({
  type: "toolCall",
  id: `call_${name}`,
  name,
  arguments: arguments_,
});

const assistantMessage = (...content: unknown[]) => ({
  role: "assistant",
  stopReason: "toolUse",
  timestamp: 0,
  content,
});

describe("pi-tool-guard extension: message_end name repair", () => {
  it("registers a message_end handler", () => {
    const { handlers } = createHarness();
    expect(handlers.has("message_end")).toBe(true);
  });

  it("renames a misspelled tool call and tells the user", async () => {
    const { handlers, notify } = createHarness();
    const handler = handlers.get("message_end")!;

    const result = (await handler(
      { type: "message_end", message: assistantMessage(toolCall("codememode")) },
      ctx(notify),
    )) as { message: { content: Array<{ name: string }> } };

    expect(result.message.content[0]!.name).toBe("codemode");
    expect(notify).toHaveBeenCalledWith(
      'pi-tool-guard: repaired tool call "codememode" → "codemode"',
      "warning",
    );
  });

  it("repairs an edit-distance typo too", async () => {
    const { handlers, notify } = createHarness();
    const handler = handlers.get("message_end")!;

    const result = (await handler(
      { type: "message_end", message: assistantMessage(toolCall("reed", { path: "a" })) },
      ctx(notify),
    )) as { message: { content: Array<{ name: string }> } };

    expect(result.message.content[0]!.name).toBe("read");
  });

  it("returns undefined when every call is already valid", async () => {
    const { handlers, notify } = createHarness();
    const handler = handlers.get("message_end")!;

    const result = await handler(
      { type: "message_end", message: assistantMessage(toolCall("read", { path: "a" })) },
      ctx(notify),
    );

    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("ignores non-assistant messages without looking up the tool list", async () => {
    const { handlers, notify, getActiveTools } = createHarness();
    const handler = handlers.get("message_end")!;

    const result = await handler(
      { type: "message_end", message: { role: "user", content: [toolCall("codememode")] } },
      ctx(notify),
    );

    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
    expect(getActiveTools).not.toHaveBeenCalled();
  });

  it("leaves a genuinely unknown tool alone", async () => {
    const { handlers, notify } = createHarness();
    const handler = handlers.get("message_end")!;

    const result = await handler(
      { type: "message_end", message: assistantMessage(toolCall("frobnicate")) },
      ctx(notify),
    );

    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });
});