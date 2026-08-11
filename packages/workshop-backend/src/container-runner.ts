import type { GitHubRepo } from "@gadgets/workshop-shared/gatekeeper";

// Unique identifier for one container run request.
export type ContainerRunId = string;

// Request written to .agent/container-request.json on the target branch.
// A GitHub Actions workflow picks it up, executes the command, and writes a ContainerRunResult.
export type ContainerRunRequest = {
  runId: ContainerRunId;
  command: string[];
  branch: string;
};

// Result written to .agent/container-result.json by the workflow.
export type ContainerRunResult = {
  runId: ContainerRunId;
  exitCode: number;
  output: string;
  timestamp: string;
};

// Abstraction over any container/runtime that can execute arbitrary shell commands.
// The initial implementation is backed by GitHub Actions (see .github/workflows/container-run.yml).
export interface ContainerRunner {
  // Start a command in a container and return a run id. The runner writes a request file;
  // the actual execution happens asynchronously.
  requestRun(command: string[], branch: string): Promise<ContainerRunId>;

  // Poll for the result of a previously requested run. Returns undefined if the run has not
  // completed yet.
  getResult(runId: ContainerRunId, branch: string): Promise<ContainerRunResult | undefined>;
}

// Container runner that uses the repository's GitHub Actions workflow to execute commands.
// The agent writes a request JSON file on the branch; a workflow triggers on the push, runs
// the command inside an Ubuntu runner, and writes a result JSON file.
export class GitHubActionsContainerRunner implements ContainerRunner {
  constructor(private repo: GitHubRepo) {}

  async requestRun(command: string[], branch: string): Promise<ContainerRunId> {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const request: ContainerRunRequest = { runId, command, branch };
    const path = ".agent/container-request.json";
    const message = `Request container run: ${command.join(" ")}`;
    const content = JSON.stringify(request, null, 2);

    const existing = await this.repo.readFile(path, branch).catch(() => undefined);
    await this.repo.writeFile({
      path,
      message,
      content,
      sha: existing?.sha,
      branch,
    });
    return runId;
  }

  async getResult(runId: ContainerRunId, branch: string): Promise<ContainerRunResult | undefined> {
    const path = ".agent/container-result.json";
    try {
      const file = await this.repo.readFile(path, branch);
      const text = atob(file.contentBase64);
      const result = JSON.parse(text) as ContainerRunResult;
      if (result.runId !== runId) return undefined;
      return result;
    } catch {
      return undefined;
    }
  }
}
