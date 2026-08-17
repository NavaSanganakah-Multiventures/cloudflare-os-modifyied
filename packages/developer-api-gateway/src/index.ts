import { DurableObject } from "cloudflare:workers";
import { GitHubClient } from "./github-client.js";

export class DeveloperApiGateway extends DurableObject {
  private github: GitHubClient;
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN missing");
    if (!env.GITHUB_OWNER || !env.GITHUB_REPO) throw new Error("GITHUB_OWNER/REPO missing");
    this.github = new GitHubClient(env.GITHUB_TOKEN, env.GITHUB_OWNER, env.GITHUB_REPO);
  }
  async fetch(request: Request): Promise<Response> {
    return new Response(JSON.stringify({ ok: true, path: new URL(request.url).pathname }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const id = env.DEVELOPER_API_GATEWAY.idFromName("default");
    const stub = env.DEVELOPER_API_GATEWAY.get(id);
    return stub.fetch(request);
  }
} satisfies ExportedHandler<Cloudflare.Env>;
