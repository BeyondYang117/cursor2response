import { expect, test, vi } from "vitest";
import { withAccessPolicy } from "./access-policy.ts";
import { json } from "../core/http.ts";

test("rejects untrusted browser origins before invoking the API, including simple requests and preflight", async () => {
  const handler = vi.fn(async () => json({ ok: true }));
  const route = withAccessPolicy(handler, {});
  for (const origin of ["https://untrusted.example", "null", "http://localhost:3000"]) {
    for (const method of ["POST", "OPTIONS"]) {
      const response = await route(new Request("http://localhost/v1/responses", {
        method, headers: { origin, "content-type": "text/plain" }, ...(method === "POST" ? { body: "{}" } : {})
      }));
      expect(response.status).toBe(403);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    }
  }
  expect(handler).not.toHaveBeenCalled();
  expect((await route(new Request("http://localhost/v1/models"))).status).toBe(200);
});

test("allows only configured origins and authenticates actual requests separately from preflight", async () => {
  const handler = vi.fn(async () => json({ ok: true }));
  const route = withAccessPolicy(handler, { C2R_API_TOKEN: "gateway-test-token", C2R_ALLOWED_ORIGINS: "http://localhost:3000" });
  const request = (headers: Record<string, string> = {}, method = "POST") => new Request("http://localhost/v1/responses", {
    method, headers: { origin: "http://localhost:3000", ...headers }
  });
  const preflight = await route(request({}, "OPTIONS"));
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-headers")).toContain("x-c2r-token");
  expect(handler).not.toHaveBeenCalled();
  const rejectedHeaders: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { "x-c2r-token": "wrong" }];
  for (const headers of rejectedHeaders) {
    expect((await route(request(headers))).status).toBe(401);
  }
  const acceptedHeaders: Record<string, string>[] = [{ authorization: "Bearer gateway-test-token" }, { "x-c2r-token": "gateway-test-token", authorization: "Bearer cursor-test-key" }];
  for (const headers of acceptedHeaders) {
    const response = await route(request(headers));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(response.headers.get("vary")).toContain("Origin");
  }
  expect((await route(new Request("http://localhost/health"))).status).toBe(200);
});

test.each(["*", "null", "https://example.test/path", "https://user:password@example.test"])("rejects unsafe allowed-origin configuration %s", (origin) => {
  expect(() => withAccessPolicy(async () => json({}), { C2R_ALLOWED_ORIGINS: origin })).toThrow();
});
