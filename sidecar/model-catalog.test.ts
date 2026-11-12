import { expect, test, vi } from "vitest";
import { ModelCatalog } from "./model-catalog.ts";

test("coalesces discovery by credential and keeps another caller alive after one cancels", async () => {
  let complete!: (value: string[]) => void;
  let upstream!: AbortSignal;
  const load = vi.fn(async (_key: string, signal: AbortSignal) => {
    upstream = signal;
    return new Promise<string[]>((resolve) => { complete = resolve; });
  });
  const catalog = new ModelCatalog(load);
  const first = new AbortController();
  const second = new AbortController();
  const one = catalog.get("synthetic-key", first.signal);
  const two = catalog.get("synthetic-key", second.signal);
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(1);
  first.abort();
  await expect(one).rejects.toMatchObject({ name: "AbortError" });
  expect(upstream.aborted).toBe(false);
  complete(["model-one"]);
  await expect(two).resolves.toEqual(["model-one"]);
  await expect(catalog.get("synthetic-key", new AbortController().signal)).resolves.toEqual(["model-one"]);
  expect(load).toHaveBeenCalledTimes(1);
});

test("cancels discovery after its last caller leaves and admits a fresh lookup", async () => {
  let upstream!: AbortSignal;
  const load = vi.fn((_key: string, signal: AbortSignal) => {
    upstream = signal;
    return new Promise<string[]>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const catalog = new ModelCatalog(load);
  const controller = new AbortController();
  const lookup = catalog.get("synthetic-key", controller.signal);
  await Promise.resolve();
  controller.abort();
  await expect(lookup).rejects.toMatchObject({ name: "AbortError" });
  expect(upstream.aborted).toBe(true);
  load.mockResolvedValueOnce(["fresh-model"]);
  await expect(catalog.get("synthetic-key", new AbortController().signal)).resolves.toEqual(["fresh-model"]);
  expect(load).toHaveBeenCalledTimes(2);
});

test("does not cache failures or share catalogs between different credentials", async () => {
  const load = vi.fn(async (key: string) => [key]);
  load.mockRejectedValueOnce(new Error("discovery failed"));
  const catalog = new ModelCatalog(load);
  const signal = new AbortController().signal;
  await expect(catalog.get("one", signal)).rejects.toThrow("discovery failed");
  await expect(catalog.get("one", signal)).resolves.toEqual(["one"]);
  await expect(catalog.get("two", signal)).resolves.toEqual(["two"]);
  expect(load).toHaveBeenCalledTimes(3);
});
