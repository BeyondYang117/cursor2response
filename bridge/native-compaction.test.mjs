import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const state = vi.hoisted(() => {
  const directory = `/tmp/cursor2response-compaction-${process.pid}-${Date.now()}`;
  process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR = directory;
  return { directory };
});
import { Agent, acknowledgePendingAgentOutput, agentCacheKey, normalizeResumeToolResults, runLocalAgentBody } from "./server.mjs";
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

async function* summaryEvents() {
  yield { type: "summary", status: "running" };
  yield { type: "summary", status: "completed" };
  yield { type: "summary", status: "error" };
  yield { type: "summary", status: "completed", fallback: true };
}

function harness(send) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const agent = { agentId: crypto.randomUUID(), close: vi.fn(), send: vi.fn(send) };
  const create = vi.spyOn(Agent, "create").mockResolvedValue(agent);
  const requests = [];
  const events = [];
  const restarts = [];
  const sessionKey = crypto.randomUUID();
  async function request(body, restart = false) {
    const prepared = prepareResponsesRequest(body, { id: "grok-4.6" });
    const continuation = responseToolContinuation(body);
    const completion = await createCursorSdkCompletion({ CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" }, {
      now: () => new Date(), randomUUID: () => crypto.randomUUID(),
      fetch: async (_url, init) => {
        const wire = JSON.parse(init.body);
        requests.push(wire);
        const input = {
          ...wire, workingDirectory: state.directory,
          clientTools: prepared.tools ?? [],
          resumeToolResults: normalizeResumeToolResults(wire.resumeToolResults, {}),
          hasIncrementalPrompt: Boolean(wire.incrementalPrompt), fullReplay: !wire.incrementalPrompt,
          supersededToolCallIds: wire.supersededToolCallIds ?? []
        };
        let output;
        if (restart) {
          // A fresh process has no actors or callbacks. Only the persisted
          // Bridge checkpoint crosses this boundary; mock the SDK cloud seam.
          const script = `
            import { readFileSync } from "node:fs";
            import { Agent, runLocalAgentBody } from ${JSON.stringify(new URL("./server.mjs", import.meta.url).href)};
            console.info = () => {};
            console.warn = () => {};
            const input = JSON.parse(readFileSync(0, "utf8"));
            let resumed = false, sentPrompt;
            const agent = { agentId: ${JSON.stringify(agent.agentId)}, close() {},
              async send(prompt, options) {
                sentPrompt = prompt;
                await options.onDelta({ update: { type: "summary-started" } });
                return { id: "restart-run", async cancel() {},
                  async *stream() {
                    yield { type: "summary", status: "completed", fallback: true };
                    yield { type: "assistant", message: { content: [{ type: "text", text: "resumed answer" }] } };
                  },
                  async wait() { return { status: "finished", result: "" }; }
                };
              }
            };
            Agent.resume = async (id) => {
              if (id !== agent.agentId) throw new Error("wrong persisted Agent");
              resumed = true; return agent;
            };
            Agent.create = async () => agent;
            const output = await runLocalAgentBody(input);
            process.stdout.write(JSON.stringify({ output, resumed, sentPrompt }));
          `;
          const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
            input: JSON.stringify(input), encoding: "utf8", timeout: 10_000,
            env: { ...process.env, CURSOR_SDK_BRIDGE_AGENT_STATE_DIR: state.directory }
          });
          expect(child.status, child.stderr).toBe(0);
          const result = JSON.parse(child.stdout);
          restarts.push(result);
          output = result.output;
        } else output = await runLocalAgentBody(input, (event) => events.push(event));
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
  return { agent, create, requests, events, request, warn, restarts };
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
          yield* summaryEvents();
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
              yield* summaryEvents();
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

  it.each([false, true])("restores only clean checkpoints after compaction and process replacement (dirty=%s)", async (dirty) => {
    const h = harness(async (_prompt, options) => {
      await compact(options);
      return {
        id: crypto.randomUUID(), cancel: vi.fn(),
        async *stream() { yield* summaryEvents(); yield assistant("first answer"); },
        wait: async () => ({ status: "finished", result: "" })
      };
    });
    const body = { input: [{ role: "user", content: "Initial task" }] };
    await expect(h.request(body)).resolves.toMatchObject({ text: "first answer" });
    const wire = h.requests[0];
    const filename = path.join(state.directory, `${agentCacheKey({ ...wire, workingDirectory: state.directory })}.json`);
    const checkpoint = JSON.parse(readFileSync(filename, "utf8"));
    expect(checkpoint.dirty).toBe(false);
    if (dirty) writeFileSync(filename, JSON.stringify({ ...checkpoint, dirty: true }));
    body.input.push({ role: "assistant", content: "first answer" }, { role: "user", content: "Next task" });
    await expect(h.request(body, true)).resolves.toMatchObject({ text: "resumed answer" });
    expect(h.restarts[0].resumed).toBe(!dirty);
    if (dirty) expect(h.restarts[0].sentPrompt).toContain("USER: Initial task");
    else expect(h.restarts[0].sentPrompt).toBe("INPUT:\nUSER: Next task");
    expect(JSON.parse(readFileSync(filename, "utf8")).dirty).toBe(false);
  });

  it.each([
    { type: "summary", status: "unknown" },
    { type: "summary" },
    { type: "summary", status: "completed", fallback: "true" }
  ])("rejects malformed SDK summary events: %j", async (event) => {
    const h = harness(async () => ({
      id: crypto.randomUUID(), cancel: vi.fn(),
      async *stream() { yield event; yield assistant("must not escape"); },
      wait: async () => ({ status: "finished", result: "" })
    }));
    await expect(h.request({ input: "Summarize" })).rejects.toThrow("unsupported semantic event");
    expect(h.events.some((event) => event.type === "text")).toBe(false);
  });
});
