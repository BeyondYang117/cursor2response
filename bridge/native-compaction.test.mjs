import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const state = vi.hoisted(() => {
  const directory = `/tmp/cursor2response-compaction-${process.pid}-${Date.now()}`;
  process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR = directory;
  return { directory };
});
import { Agent, acknowledgePendingAgentOutput, normalizeResumeToolResults, runLocalAgentBody } from "./server.mjs";
import { collectCursorSdkOutput, createCursorSdkCompletion } from "../core/cursor-sdk.ts";
import { prepareResponsesRequest, responseToolContinuation } from "../core/openai.ts";

afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(state.directory, { recursive: true, force: true }));

const assistant = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
async function compact(options) {
  for (const update of [
    { type: "summary-started" },
    { type: "summary", summary: "Synthetic SDK checkpoint summary" },
    { type: "summary-completed" }
  ]) await options.onDelta({ update });
}

function harness(send) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const agent = { agentId: crypto.randomUUID(), close: vi.fn(), send: vi.fn(send) };
  const create = vi.spyOn(Agent, "create").mockResolvedValue(agent);
  const requests = [];
  const events = [];
  const sessionKey = crypto.randomUUID();
  async function request(body) {
    const prepared = prepareResponsesRequest(body, { id: "grok-4.6" });
    const continuation = responseToolContinuation(body);
    const completion = await createCursorSdkCompletion({ CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" }, {
      now: () => new Date(), randomUUID: () => crypto.randomUUID(),
      fetch: async (_url, init) => {
        const wire = JSON.parse(init.body);
        requests.push(wire);
        const output = await runLocalAgentBody({
          ...wire, workingDirectory: state.directory,
          clientTools: prepared.tools ?? [],
          resumeToolResults: normalizeResumeToolResults(wire.resumeToolResults, {}),
          hasIncrementalPrompt: Boolean(wire.incrementalPrompt), fullReplay: !wire.incrementalPrompt,
          supersededToolCallIds: wire.supersededToolCallIds ?? []
        }, (event) => events.push(event));
        acknowledgePendingAgentOutput(output);
        return Response.json(output);
      }
    }, "synthetic-test-key", {
      prompt: prepared.prompt, agentContext: prepared.agentContext, sessionKey,
      model: { id: "grok-4.6" }, clientTools: prepared.tools,
      resumeToolResults: continuation.results
    });
    return collectCursorSdkOutput(completion.stream);
  }
  return { agent, create, requests, events, request, warn };
}

describe("Responses native SDK compaction", () => {
  it.each([false, true])("continues streamed text through compaction (observation fails=%s)", async (observationFails) => {
    const cancel = vi.fn();
    const h = harness(async (_prompt, options) => {
      await compact(options); // Agent.send has not returned its Run yet.
      return {
        id: crypto.randomUUID(), cancel,
        async *stream() {
          yield assistant("before ");
          await compact(options);
          yield assistant("after");
        },
        wait: async () => ({ status: "finished", result: "" })
      };
    });
    if (observationFails) h.warn.mockImplementation((message) => {
      if (JSON.parse(message).event === "cursor_sdk_summary_update") throw new Error("observation unavailable");
    });
    const output = await h.request({ input: [{ role: "user", content: "Continue after compaction" }] });
    expect(output.text).toBe("before after");
    expect(h.events.filter((event) => event.type === "text").map((event) => event.text).join("")).toBe("before after");
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.agent.send).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(h.agent.close).not.toHaveBeenCalled();
  });

  it("preserves two tool continuations, duplicate callback results and incremental history across compaction", async () => {
    const cancel = vi.fn();
    const results = [];
    let sends = 0;
    const h = harness(async (_prompt, options) => {
      const toolRun = ++sends === 1;
      await compact(options);
      return {
        id: crypto.randomUUID(), cancel,
        async *stream() {
          if (toolRun) {
            const tool = options.local.customTools.inspect;
            for (const step of [1, 2]) {
              await compact(options);
              const context = { toolCallId: `sdk-inspect-${step}` };
              const result = await tool.execute({ step }, context);
              results.push(result);
              await compact(options);
              expect(await tool.execute({ step }, context)).toEqual(result);
            }
          }
          yield assistant("done");
        },
        wait: async () => ({ status: "finished", result: "" })
      };
    });
    const body = {
      tools: [{ type: "function", name: "inspect", parameters: {
        type: "object", properties: { step: { type: "number" } }, required: ["step"]
      } }],
      input: [{ role: "user", content: "Inspect twice" }]
    };
    let output = await h.request(body);
    const publicIds = [];
    for (const step of [1, 2]) {
      expect(output.toolCalls).toHaveLength(1);
      const call = output.toolCalls[0];
      publicIds.push(call.callId);
      body.input.push(
        { type: "function_call", call_id: call.callId, name: "inspect", arguments: JSON.stringify({ step }) },
        { type: "function_call_output", call_id: call.callId, output: `result ${step}` }
      );
      output = await h.request(body);
    }
    expect(new Set(publicIds).size).toBe(2);
    expect(output.text).toBe("done");
    expect(results).toEqual(["result 1", "result 2"]);
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.agent.send).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(h.agent.close).not.toHaveBeenCalled();

    body.input.push({ role: "assistant", content: "done" }, { role: "user", content: "Next turn" });
    await h.request(body);
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.agent.send).toHaveBeenCalledTimes(2);
    expect(h.agent.send.mock.calls[1][0]).toBe("INPUT:\nUSER: Next turn");

    // Native checkpoint compaction must not bypass public transcript validation.
    body.input[0] = { role: "user", content: "Edited earlier history" };
    body.input.push({ role: "assistant", content: "done" }, { role: "user", content: "Continue" });
    await h.request(body);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.agent.send.mock.calls[2][0]).toContain("USER: Edited earlier history");
    expect(h.requests[4].agentContext.transcriptItemHashes[0])
      .not.toBe(h.requests[0].agentContext.transcriptItemHashes[0]);
  });

  it("still reports actual SDK execution failures after native compaction", async () => {
    const h = harness(async (_prompt, options) => {
      await compact(options);
      return {
        id: crypto.randomUUID(), cancel: vi.fn(),
        async *stream() { throw new Error("synthetic SDK execution failure"); },
        wait: async () => ({ status: "error", error: { message: "synthetic SDK execution failure" } })
      };
    });
    await expect(h.request({ input: "Fail after compaction" })).rejects.toThrow("synthetic SDK execution failure");
  });
});
