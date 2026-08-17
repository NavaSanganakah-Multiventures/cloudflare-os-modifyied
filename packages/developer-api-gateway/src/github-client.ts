export interface Repository {
  owner: string;
  name: string;
}

export interface GitHubFile {
  sha: string;
  content: string;
}

export interface IssueResult {
  number: number;
  url: string;
}

export interface PullRequestResult {
  number: number;
  url: string;
  branch: string;
}

export class GitHubClient {
  private token: string;
  private baseUrl = "https://api.github.com";

  constructor(token: string) {
    this.token = token;
  }

  private async request(path: string, init: RequestInit = { method: "GET" }): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "developer-api-gateway",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API ${init.method} ${path} failed: ${response.status} ${body.slice(0, 200)}`);
    }
    return response;
  }

  private encode(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  async createIssue(repo: Repository, title: string, body: string, labels: string[] = []): Promise<IssueResult> {
    const response = await this.request(`/repos/${repo.owner}/${repo.name}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body, labels }),
    });
    const json = (await response.json()) as { number: number; html_url: string };
    return { number: json.number, url: json.html_url };
  }

  async getFile(repo: Repository, path: string, ref = "main"): Promise<GitHubFile | null> {
    try {
      const response = await this.request(`/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(path)}?ref=${ref}`);
      const json = (await response.json()) as { sha: string; content: string };
      const content = atob(json.content.replace(/\s/g, ""));
      return { sha: json.sha, content };
    } catch (e) {
      if (String(e).includes("404")) return null;
      throw e;
    }
  }

  async createBranch(repo: Repository, branchName: string, baseSha: string): Promise<void> {
    await this.request(`/repos/${repo.owner}/${repo.name}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
    });
  }

  async getRef(repo: Repository, ref: string): Promise<string> {
    const response = await this.request(`/repos/${repo.owner}/${repo.name}/git/ref/${ref}`);
    const json = (await response.json()) as { object: { sha: string } };
    return json.object.sha;
  }

  async writeFile(repo: Repository, path: string, message: string, content: string, branch: string, sha?: string): Promise<{ commitSha: string }> {
    const body: Record<string, string> = {
      message,
      content: this.encode(content),
      branch,
    };
    if (sha) body.sha = sha;
    const response = await this.request(`/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as { commit: { sha: string } };
    return { commitSha: json.commit.sha };
  }

  async createPullRequest(repo: Repository, title: string, head: string, base: string, body: string): Promise<PullRequestResult> {
    const response = await this.request(`/repos/${repo.owner}/${repo.name}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title, head, base, body }),
    });
    const json = (await response.json()) as { number: number; html_url: string };
    return { number: json.number, url: json.html_url, branch: head };
  }

  async workflowExists(repo: Repository, path: string, ref = "main"): Promise<boolean> {
    try {
      await this.request(`/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(path)}?ref=${ref}`);
      return true;
    } catch (e) {
      if (String(e).includes("404")) return false;
      throw e;
    }
  }

  async dispatchWorkflow(repo: Repository, workflowId: string, ref: string, inputs?: Record<string, string>): Promise<void> {
    await this.request(`/repos/${repo.owner}/${repo.name}/actions/workflows/${workflowId}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref, inputs }),
    });
  }
}
