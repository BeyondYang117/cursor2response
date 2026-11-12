import { expect, test, vi } from "vitest";
import { Writable, Readable } from "node:stream";
import { createNdjsonWriter } from "./http-transport.mjs";

vi.hoisted(() => { process.env.CURSOR_SDK_BRIDGE_MAX_JSON_BYTES = "1024"; });
const { readJsonBody, createPendingAgentRun, attachPendingAgentSubscriber, consumePendingAgentRun,
  detachPendingAgentSubscriber, waitForPendingAgentEvent } = await import("./server.mjs");

test("reads split UTF-8 requests without changing prompt, tool arguments or images", async () => {
  const expected = { prompt: "你好🙂", tools: [{ arguments: "中文参数" }], images: [{ data: "AQID" }] };
  const bytes = Buffer.from(JSON.stringify(expected));
  for (let split = 1; split < bytes.length; split++) {
    await expect(readJsonBody(Readable.from([bytes.subarray(0, split), bytes.subarray(split)]))).resolves.toEqual(expected);
  }
});

test("enforces Bridge limits in bytes instead of decoded characters", async () => {
  const bytes = Buffer.from(JSON.stringify({ prompt: "你".repeat(400) }));
  await expect(readJsonBody(Readable.from([bytes]))).rejects.toMatchObject({ status: 413, code: "request_too_large" });
  await expect(readJsonBody(Readable.from([Buffer.from("{")]))).rejects.toMatchObject({ status: 400, code: "invalid_json" });
});

function slowResponse() {
  const chunks = [];
  const callbacks = [];
  const response = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    chunks.push(chunk.toString());
    callbacks.push(callback);
  } });
  return { response, chunks, flush: () => callbacks.shift()?.() };
}

test("waits for transport drain and writes each event exactly once", async () => {
  const { response, chunks, flush } = slowResponse();
  const writer = createNdjsonWriter(response);
  expect(writer.write({ type: "text", text: "中文🙂" })).toBe(true);
  let drained = false;
  const ready = writer.write.drain().then((ok) => { drained = ok; });
  await Promise.resolve();
  expect(drained).toBe(false);
  flush();
  await ready;
  expect(drained).toBe(true);
  expect(chunks).toEqual([JSON.stringify({ type: "text", text: "中文🙂" }) + "\n"]);
  writer.close();
  response.destroy();
});

test.each(["abort", "disconnect", "replacement"])("releases a blocked writer on %s", async (reason) => {
  const { response } = slowResponse();
  const controller = new AbortController();
  const writer = createNdjsonWriter(response, controller.signal);
  writer.write({ type: "text", text: "pending" });
  const ready = writer.write.drain();
  if (reason === "abort") controller.abort();
  else if (reason === "replacement") writer.close();
  else response.destroy();
  await expect(ready).resolves.toBe(false);
  expect(response.listenerCount("drain")).toBe(0);
  response.destroy();
});

test("disconnects a slow subscriber before its buffer exceeds the bound", () => {
  const { response } = slowResponse();
  const writer = createNdjsonWriter(response, undefined, 64);
  expect(writer.write({ text: "x".repeat(20) })).toBe(true);
  expect(writer.write({ text: "x".repeat(40) })).toBe(false);
  expect(response.destroyed).toBe(true);
  writer.close();
});

test("SDK consumption pauses for a slow subscriber and replacement releases it without losing subsequent events", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const { response, chunks } = slowResponse();
  const writer = createNdjsonWriter(response);
  writer.write.detach = writer.close;
  const pending = createPendingAgentRun(crypto.randomUUID(), { agent: { agentId: "test-agent" } }, "request-one", "test-session");
  attachPendingAgentSubscriber(pending, { requestId: "request-one", eventSink: writer.write });
  let pulled = 0;
  const run = { id: "test-run", async *stream() {
    for (const text of ["first", "second", "third"]) {
      pulled++;
      yield { type: "assistant", message: { content: [{ type: "text", text }] } };
    }
  }, wait: async () => ({ status: "finished", result: "" }) };
  const completion = consumePendingAgentRun(pending, run);
  try {
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    expect(pulled).toBe(2);
    const replacement = vi.fn();
    const subscriber = attachPendingAgentSubscriber(pending, { requestId: "request-two", eventSink: replacement });
    await completion;
    expect(chunks.map((chunk) => JSON.parse(chunk).text)).toEqual(["first"]);
    expect(replacement.mock.calls.map(([event]) => event.text)).toEqual(["second", "third"]);
    detachPendingAgentSubscriber(subscriber);
    await waitForPendingAgentEvent(pending);
  } finally {
    writer.close();
    response.destroy();
    info.mockRestore();
  }
});
