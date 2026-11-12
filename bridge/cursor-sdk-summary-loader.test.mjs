import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  CURSOR_SDK_SUMMARY_FILTER_SIGNATURE,
  CURSOR_SDK_SUMMARY_HOOK_MARKER,
  CURSOR_SDK_SUMMARY_HOOK_VERSION,
  resolveCursorSdkLoadContract,
  transformCursorSdkSource
} from "./cursor-sdk-summary-loader.mjs";

// Exercise the installed accumulator, including its conversation bookkeeping,
// without starting an executor or making a model request. Its usage() method
// references another bundle module; this test only uses apply/conversation.
function installedAccumulator(source) {
  const ast = ts.createSourceFile("sdk.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = [];
  function visit(node) {
    if (ts.isClassDeclaration(node)) {
      const methods = new Set(node.members.map((member) => member.name?.getText(ast)));
      if (["apply", "flushPendingStep", "mergeIntoConversation"].every((name) => methods.has(name))) {
        matches.push(node.getText(ast));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(matches).toHaveLength(1);
  return runInNewContext(`(${matches[0]})`);
}

describe("Cursor SDK summary loader", () => {
  it.each([false, true])("preserves real accumulator text and tools with awaited summary callbacks (hook=%s)", async (hook) => {
    const contract = resolveCursorSdkLoadContract();
    const original = readFileSync(fileURLToPath(contract.entryUrl), "utf8");
    const source = hook ? transformCursorSdkSource(original, {
      url: contract.entryUrl, expectedUrl: contract.entryUrl, packageVersion: contract.packageVersion
    }) : original;
    const Accumulator = installedAccumulator(source);
    const observed = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const accumulator = new Accumulator({ onDelta: async ({ update }) => {
      if (update.type === "summary-started") await gate;
      observed.push(update);
    } });
    const text = { type: "text-delta", text: "before " };
    await accumulator.apply(text);
    let completed = false;
    const started = { type: "summary-started" };
    const pending = accumulator.apply(started).then(() => { completed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toBe(!hook);
    release();
    await pending;
    const updates = [
      { type: "summary", summary: "synthetic checkpoint" },
      { type: "summary-completed", failed: true, fallback: true },
      { type: "text-delta", text: "after" },
      { type: "tool-requests-listed", callCount: 1 },
      { type: "tool-call-completed", toolCall: { type: "inspect", args: { step: 1 } } }
    ];
    for (const update of updates) await accumulator.apply(update);
    expect(observed).toEqual(hook ? [text, started, ...updates] : [text, ...updates.slice(2)]);
    expect(accumulator.conversation()[0].turn.steps).toEqual([
      { type: "assistantMessage", message: { text: "before after" } },
      { type: "toolCall", message: { type: "inspect", args: { step: 1 } } }
    ]);
  });

  it("transforms the installed ESM bundle exactly once", () => {
    const contract = resolveCursorSdkLoadContract();
    const source = readFileSync(fileURLToPath(contract.entryUrl), "utf8");
    const transformed = transformCursorSdkSource(source, {
      url: contract.entryUrl,
      expectedUrl: contract.entryUrl,
      packageVersion: contract.packageVersion
    });

    expect(contract.packageVersion).toBe(CURSOR_SDK_SUMMARY_HOOK_VERSION);
    expect(source.split(CURSOR_SDK_SUMMARY_FILTER_SIGNATURE)).toHaveLength(2);
    expect(transformed).not.toContain(CURSOR_SDK_SUMMARY_FILTER_SIGNATURE);
    expect(transformed).toContain(`Symbol.for(${JSON.stringify(CURSOR_SDK_SUMMARY_HOOK_MARKER)})`);
  });

  it.each([
    ["previous pinned version", { packageVersion: "1.0.31" }],
    ["URL", { url: "file:///tmp/not-cursor-sdk.js" }],
    ["signature", { source: "export const sdk = true;" }],
    ["duplicate signature", { source: `${CURSOR_SDK_SUMMARY_FILTER_SIGNATURE};${CURSOR_SDK_SUMMARY_FILTER_SIGNATURE}` }]
  ])("fails closed on %s drift", (_name, overrides) => {
    const contract = resolveCursorSdkLoadContract();
    const source = overrides.source ?? readFileSync(fileURLToPath(contract.entryUrl), "utf8");
    expect(() => transformCursorSdkSource(source, {
      url: contract.entryUrl,
      expectedUrl: contract.entryUrl,
      packageVersion: contract.packageVersion,
      ...overrides
    })).toThrowError(expect.objectContaining({
      code: "cursor_sdk_summary_hook_contract_mismatch"
    }));
  });

  it("loads the real SDK through the hook in a child process", () => {
    const loaderUrl = new URL("./cursor-sdk-summary-loader.mjs", import.meta.url).href;
    const source = `
      import { registerHooks } from "node:module";
      import { CURSOR_SDK_SUMMARY_HOOK_MARKER, createCursorSdkSummaryHooks, resolveCursorSdkLoadContract } from ${JSON.stringify(loaderUrl)};
      const contract = resolveCursorSdkLoadContract();
      registerHooks(createCursorSdkSummaryHooks(contract));
      await import(contract.entryUrl);
      const marker = globalThis[Symbol.for(CURSOR_SDK_SUMMARY_HOOK_MARKER)];
      if (marker?.version !== contract.packageVersion || marker?.url !== contract.entryUrl) process.exit(2);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 30_000
    });

    expect(result.status, result.stderr).toBe(0);
  });
});
