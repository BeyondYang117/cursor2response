import { describe, expect, it } from "vitest";
import { z } from "zod";
import { prepareResponsesRequest } from "../core/openai.ts";
import { localAgentSendOptions, validateClientMcpToolCall } from "./server.mjs";

// Load after the Bridge has installed its SDK source hook. These parsers are
// the SDK's real Zod schemas, including its retained zod/v3 compatibility path.
const { InteractionUpdateSchema, ToolCallCompletedUpdateSchema } = await import("@cursor/sdk");

describe("Zod collection limits", () => {
  it.each(["array", "set", "map"])("rejects an oversized %s before validating its elements", (kind) => {
    let visits = 0;
    const element = z.string().superRefine(() => { visits += 1; });
    const schema = kind === "array" ? z.array(element).max(2)
      : kind === "set" ? z.set(element).max(2) : z.map(z.string(), element).max(2);
    const values = ["one", "two", "three"];
    const input = kind === "array" ? values
      : kind === "set" ? new Set(values) : new Map(values.map((value) => [value, value]));
    expect(schema.safeParse(input).success).toBe(false);
    expect(visits).toBe(0);
  });
});

describe("SDK tool schemas with Zod 4", () => {
  const schema = z.object({
    value: z.string().nullable(),
    items: z.array(z.object({ enabled: z.boolean(), label: z.string().optional() })),
    labels: z.record(z.string(), z.number()),
    choice: z.union([z.string(), z.number()])
  });
  const parameters = z.toJSONSchema(schema);
  const prepared = prepareResponsesRequest({ input: "Inspect", tools: [{
    type: "function", name: "inspect", parameters,
    output_schema: { type: "object", properties: { ok: { type: "boolean" } } },
    annotations: { readOnlyHint: true, destructiveHint: false }
  }] }, { id: "grok-4.6" });
  const tool = localAgentSendOptions({ model: "grok-4.6", clientTools: prepared.tools }).local.customTools.inspect;
  const valid = { value: null, items: [{ enabled: false }], labels: { count: 2 }, choice: 0 };

  it("preserves generated JSON Schema and explicit tool metadata", () => {
    expect(tool.inputSchema).toEqual(parameters);
    expect(tool.outputSchema).toEqual(prepared.tools[0].outputSchema);
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it.each([
    [valid, true],
    [{ value: "text", items: [], labels: {}, choice: "mode" }, true],
    [{ items: [], labels: {}, choice: 1 }, false],
    [{ ...valid, items: [{ enabled: "false" }] }, false],
    [{ ...valid, labels: { count: "2" } }, false],
    [{ ...valid, choice: null }, false]
  ])("keeps nullable, required, record and union argument semantics %#", (args, accepted) => {
    const update = { type: "tool-call-started", callId: "schema-call", modelCallId: "schema-model", toolCall: {
      type: "mcp", args: { providerIdentifier: "custom-user-tools", toolName: "inspect", args }
    } };
    const parsed = InteractionUpdateSchema.parse(update);
    expect(parsed).toEqual(update);
    expect(schema.safeParse(args).success).toBe(accepted);
    expect(validateClientMcpToolCall([{ name: "inspect", inputSchema: tool.inputSchema }], "inspect", parsed.toolCall.args.args) === null)
      .toBe(accepted);
  });

  it("preserves SDK tool results with text, images and an explicit error flag", () => {
    const update = { type: "tool-call-completed", callId: "schema-call", modelCallId: "schema-model", toolCall: {
      type: "mcp", args: { toolName: "inspect", args: valid },
      result: { status: "success", value: { isError: true, content: [
        { text: { text: "tool failed" } }, { image: { data: "AQID", mimeType: "image/png" } }
      ] } }
    } };
    expect(ToolCallCompletedUpdateSchema.parse(update)).toEqual(update);
    expect(InteractionUpdateSchema.safeParse({ ...update, toolCall: { ...update.toolCall, args: { args: "invalid" } } }).success)
      .toBe(false);
  });
});
