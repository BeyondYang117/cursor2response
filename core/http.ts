const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8"
};

const CORS_HEADERS = {
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-api-key,x-c2r-token,idempotency-key,x-session-affinity,x-opencode-session-id,x-opencode-session,session-id,session_id,x-session-id",
  "access-control-max-age": "86400"
};

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return withCors(
    Response.json(data, {
      ...init,
      headers: {
        ...JSON_HEADERS,
        ...init.headers
      }
    })
  );
}

export function openAiError(message: string, status = 400, code = "invalid_request_error", param?: string): Response {
  return json(
    {
      error: {
        message,
        type: code,
        param: param ?? null,
        code
      }
    },
    { status }
  );
}

export function unauthorized(message = "Missing or invalid API key"): Response {
  return openAiError(message, 401, "unauthorized");
}

export function notFound(): Response {
  return openAiError("Not found", 404, "not_found");
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly param?: string;

  constructor(message: string, status = 400, code = "invalid_request_error", param?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

export async function readJsonRequest(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError("Request body must be a JSON object.", 400, "invalid_request_error");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    request.signal.throwIfAborted();
    if (error instanceof SyntaxError) throw new HttpError("Invalid JSON request body.", 400, "invalid_json");
    throw error;
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return openAiError(error.message, error.status, error.code, error.param);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return openAiError(message, 500, "internal_error");
}

export function sseResponse(readable: ReadableStream<Uint8Array>): Response {
  return withCors(
    new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    })
  );
}
