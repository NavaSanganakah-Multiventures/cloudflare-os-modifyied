import type { ExecutionContext, Request, Response as CfResponse } from "@cloudflare/workers-types";
import type { Env } from "./server.js";
import { getAuthGatekeeperAllowlist } from "./auth/config.js";
import { getAuthVendorBinding } from "./auth/auth-vendors.js";

// Helper to authenticate requests and return the user stub
async function authenticateRequest(req: Request, env: Env, ctx: ExecutionContext) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }
  const token = authHeader.substring(7);
  let split = token.split(':');
  if (split.length !== 2) {
    throw new Error("Invalid token format");
  }

  let userId = ctx.exports.UserDurableObject.idFromName(split[0]);
  let userStub = ctx.exports.UserDurableObject.get(userId);
  await userStub.authenticate(split[1]);
  return userStub;
}

export async function handleMobileApiRequest(req: Request, env: Env, ctx: ExecutionContext): Promise<CfResponse | Response> {
  const url = new URL(req.url);
  const path = url.pathname.slice("/api/mobile/v1".length);

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  try {
    if (req.method === "GET" && path === "/health") {
      return Response.json({ status: "ok" }, { headers });
    }

    // -----------------------------------------------------
    // Authentication Endpoints
    // -----------------------------------------------------
    if (req.method === "GET" && path === "/auth/github") {
      const vendorId = "github";
      if (!getAuthGatekeeperAllowlist(env).includes(vendorId)) {
        throw new Error(`Sign-in via "github" is not enabled on this deployment.`);
      }
      const vendor = getAuthVendorBinding(env, vendorId);
      if (!vendor) throw new Error(`No such auth gatekeeper: github`);
      const desc = await vendor.describe();
      if (!desc.providesAuth) throw new Error(`"github" does not provide authentication.`);

      const pendingId = ctx.exports.PendingLogin.newUniqueId();
      const callback = ctx.exports.LoginConnectCallbackImpl({ props: { pendingId: pendingId.toString(), vendorId } });
      
      const { url: oauthUrl } = await vendor.connectAccount(callback, { scopes: "auth" });
      
      return Response.json({ url: oauthUrl, pendingId: pendingId.toString() }, { headers });
    }

    if (req.method === "GET" && path === "/auth/wait") {
      const pendingIdStr = url.searchParams.get("pendingId");
      if (!pendingIdStr) throw new Error("Missing pendingId");

      const pendingId = ctx.exports.PendingLogin.idFromString(pendingIdStr);
      const pending = ctx.exports.PendingLogin.get(pendingId);
      
      // Wait for the DO to resolve the token
      const token = await pending.awaitResult();
      return Response.json({ token }, { headers });
    }

    // -----------------------------------------------------
    // Authenticated Endpoints
    // -----------------------------------------------------
    
    // Who Am I
    if (req.method === "GET" && path === "/whoami") {
      const userStub = await authenticateRequest(req, env, ctx);
      const info = await userStub.whoami();
      return Response.json({ info }, { headers });
    }

    // Workspaces
    if (req.method === "GET" && path === "/workspaces") {
      const userStub = await authenticateRequest(req, env, ctx);
      const workspaces = await userStub.listWorkspaces();
      return Response.json({ workspaces }, { headers });
    }

    if (req.method === "POST" && path === "/workspaces") {
      const userStub = await authenticateRequest(req, env, ctx);
      const body: any = await req.json();
      const overseers = ctx.exports.OverseerDurableObject;
      const id = overseers.newUniqueId().toString();
      await userStub.newWorkspace(id, body.title || "Untitled Workspace");
      return Response.json({ id, title: body.title || "Untitled Workspace" }, { headers });
    }

    if (req.method === "DELETE" && path === "/workspaces") {
      const userStub = await authenticateRequest(req, env, ctx);
      const id = url.searchParams.get("id");
      if (!id) throw new Error("Missing workspace id");
      await userStub.forgetSharedGadget(id); // Delete/forget workspace
      return Response.json({ status: "deleted" }, { headers });
    }

    // Gatekeepers
    if (req.method === "GET" && path === "/gatekeepers") {
      const userStub = await authenticateRequest(req, env, ctx);
      const vendors = await userStub.listGatekeeperVendors();
      return Response.json({ vendors }, { headers });
    }

    return Response.json({ error: "Endpoint not found" }, { status: 404, headers });
  } catch (error: any) {
    return Response.json({ error: error.message || "Internal Server Error" }, { status: 500, headers });
  }
}
