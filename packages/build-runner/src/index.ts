import { Container, getContainer } from "@cloudflare/containers";
import { DurableObjectNamespace, WorkerEntrypoint } from "cloudflare:workers";

export interface BuildRequest {
  /** HTTPS URL used to clone the repository. For private repos, embed an access token. */
  repoUrl: string;
  /** Branch or ref to check out. */
  branch: string;
  /** Shell commands to run in the cloned repository. */
  commands: string[];
}

export interface BuildResult {
  /** Whether all commands exited with code 0. */
  success: boolean;
  /** The exit code of the last executed command (or the clone step). */
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Container that runs inside Cloudflare Containers. It hosts the Python build
 * server defined in the repository Dockerfile.
 */
export class BuildRunnerContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = true;
}

/**
 * Worker entrypoint exposed to the GitHub gatekeeper. Given a build request,
 * it forwards the request to a container instance keyed by the repository URL.
 */
export default class BuildRunner extends WorkerEntrypoint<{
  BUILD_RUNNER_CONTAINER: DurableObjectNamespace<BuildRunnerContainer>;
}> {
  async runBuild(request: BuildRequest): Promise<BuildResult> {
    const container = getContainer(this.env.BUILD_RUNNER_CONTAINER, request.repoUrl);
    const response = await container.fetch(
      new Request("http://container/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }),
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Build runner container returned ${response.status}: ${text}`);
    }

    return (await response.json()) as BuildResult;
  }
}
