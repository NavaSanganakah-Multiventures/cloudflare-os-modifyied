// GitHub API client used by the developer API gateway.
// This uses a raw GitHub PAT/App token for simplicity. In the future it can be replaced by
// an RPC binding to packages/gatekeeper-github so all writes flow through the approval queue.

export interface GitHubFileResponse {
  sha: string;
  content?: string;
  encoding?: "base64";
}

export class GitHubClient {
  constructor(
    private token: string,
    private owner: string,
    private repo: string,
  ) {}

  private req(path: string, init?: RequestInit<RequestInitCfProperties>) {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.headers ?? {}),
      },
    });
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<{ number: number; url: string }> {
    const res = await this.req("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, labels }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`GitHub createIssue failed: ${res.status} ${txt}`);
    }
    const data = await res.json<any>();
    return { number: data.number, url: data.html_url };
  }

  async getFile(path: string, ref = "main"): Promise<GitHubFileResponse> {
    const encoded = encodeURIComponent(path);
    const res = await this.req(`/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`GitHub getFile failed: ${res.status} ${txt}`);
    }
    return res.json<GitHubFileResponse>();
  }

  async writeFile(path: string, message: string, content: string, branch: string, sha?: string): Promise<{ commitSha: string }> {
    const encoded = encodeURIComponent(path);
    const body: Record<string, string> = {
      message,
      content: btoa(content),
      branch,
    };
    if (sha) body.sha = sha;
    const res = await this.req(`/contents/${encoded}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`GitHub writeFile failed: ${res.status} ${txt}`);
    }
    const data = await res.json<any>();
    return { commitSha: data.commit?.sha ?? "" };
  }

  async createBranch(name: string, fromSha: string): Promise<{ name: string; sha: string }> {
    const res = await this.req("/git/refs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${name}`, sha: fromSha }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`GitHub createBranch failed: ${res.status} ${txt}`);
    }
    const data = await res.json<any>();
    return { name: data.ref.replace("refs/heads/", ""), sha: data.object.sha };
  }

  async createPullRequest(title: string, head: string, base: string, body: string): Promise<{ number: number; url: string }> {
    const res = await this.req("/pulls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, head, base, body }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`GitHub createPullRequest failed: ${res.status} ${txt}`);
    }
    const data = await res.json<any>();
    return { number: data.number, url: data.html_url };
  }

  async getRef(ref: string): Promise<{ sha: string }> {
    const res = await this.req(`/git/ref/${encodeURIComponent(ref)}`);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`GitHub getRef failed: ${res.status} ${txt}`);
    }
    const data = await res.json<any>();
    return { sha: data.object.sha };
  }

  async workflowExists(path: string, ref = "main"): Promise<boolean> {
    const encoded = encodeURIComponent(path);
    const res = await this.req(`/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
    return res.ok;
  }

  async dispatchWorkflow(workflowId: string, ref: string, inputs: Record<string, string>) {
    const res = await this.req(`/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, inputs }),
    });
    if (!res.ok && res.status !== 204) {
      const txt = await res.text();
      throw new Error(`GitHub dispatchWorkflow failed: ${res.status} ${txt}`);
    }
  }
}
