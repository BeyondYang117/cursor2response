import { timingSafeEqual } from "node:crypto";
import { HttpError, errorResponse, withCors } from "../core/http.ts";

function matchesToken(candidate: string, expected: string): boolean {
  const supplied = Buffer.from(candidate);
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

export function withAccessPolicy(
  handler: (request: Request) => Promise<Response>,
  environment = process.env
): (request: Request) => Promise<Response> {
  const token = environment.C2R_API_TOKEN?.trim() || "";
  const origins = new Set((environment.C2R_ALLOWED_ORIGINS || "").split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const url = new URL(entry);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("C2R_ALLOWED_ORIGINS must contain explicit HTTP(S) origins.");
    }
    return url.origin;
  }));

  return async (request) => {
    const origin = request.headers.get("origin");
    let response: Response;
    try {
      if (origin !== null && !origins.has(origin)) {
        throw new HttpError("Browser origin is not allowed.", 403, "origin_not_allowed");
      }
      const pathname = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
      const health = pathname === "/health" && ["GET", "HEAD"].includes(request.method);
      if (request.method === "OPTIONS") {
        response = withCors(new Response(null, { status: 204 }));
      } else {
        if (token && !health) {
          const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization")?.trim() || "")?.[1] || "";
          const candidate = request.headers.get("x-c2r-token")?.trim() || bearer;
          if (!matchesToken(candidate, token)) throw new HttpError("Missing or invalid gateway token.", 401, "unauthorized");
        }
        response = await handler(request);
      }
    } catch (error) {
      response = errorResponse(error);
    }
    const headers = new Headers(response.headers);
    headers.delete("access-control-allow-origin");
    if (origin !== null && origins.has(origin)) headers.set("access-control-allow-origin", origin);
    const vary = headers.get("vary");
    if (!vary?.split(",").some((value) => value.trim().toLowerCase() === "origin")) {
      headers.set("vary", vary ? `${vary}, Origin` : "Origin");
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
