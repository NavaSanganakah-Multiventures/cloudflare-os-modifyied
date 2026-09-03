import { createWorkshopLogger } from "../observability";
import { mintAryaToken } from "./arya-auth";

const logger = createWorkshopLogger("workshop.arya.voice");

// HTTP endpoints under /api/arya/ for the voice assistant. PR 2 adds the authenticated token-mint
// RPC (so the browser never sees a signing secret); PR 1 ships a dev-only token endpoint for local
// testing.

/** Valid room names: a single URL-safe segment, max 64 characters. */
const CALL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export async function handleAryaVoiceRequest(
  req: Request,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/api/arya/health") {
    return Response.json({ ok: true, enabled: Boolean(env.ARYA_SIGNING_SECRET) });
  }

  if (url.pathname === "/api/arya/dev-token") {
    return handleDevToken(url, env);
  }

  if (url.pathname === "/api/arya/ws") {
    if (!env.ARYA_SIGNING_SECRET) {
      return new Response("Arya voice is not configured (ARYA_SIGNING_SECRET missing)", {
        status: 503,
      });
    }
    const call = url.searchParams.get("call");
    if (!call || !CALL_NAME_PATTERN.test(call)) {
      return new Response("Missing or invalid call room name", { status: 400 });
    }
    return ctx.exports.AryaCallRoom.getByName(call).fetch(req);
  }

  return new Response("Not Found", { status: 404 });
}

function handleDevToken(url: URL, env: Cloudflare.Env): Promise<Response> {
  // Explicitly dev-only: production deployments never set ARYA_ALLOW_DEV_TOKEN, so this 404s.
  if (env.ARYA_ALLOW_DEV_TOKEN !== "true") {
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  }
  const userId = url.searchParams.get("user") ?? "dev-user";
  const name = url.searchParams.get("name") ?? userId;
  const call = url.searchParams.get("call") ?? "dev-" + crypto.randomUUID();

  return mintAryaToken({ sub: userId, name, call }, env)
    .then((token) => Response.json({ token, call }))
    .catch((err) => {
      logger.warn("failed to mint dev voice token", {
        event: "arya.token.mint.failed",
        error: err,
      });
      return new Response("ARYA_SIGNING_SECRET is not configured", { status: 503 });
    });
}
