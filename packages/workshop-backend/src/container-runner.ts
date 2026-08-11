// A Cloudflare Container that the coding agent uses to run build/test commands (e.g.
// pnpm run build) against completed code. This re-adds the container support that was removed
// in #8 / #9, but built on the real Cloudflare Containers runtime
// (https://developers.cloudflare.com/containers/) instead of the earlier GitHub-Actions
// file-polling hack.
//
// The container is a Durable Object: the Container class extends DurableObject, so it manages
// lifecycle, routing, and persistent SQLite storage, while the image runs in a Linux VM.
// Commands run via this.ctx.container.exec(), which starts a process inside the already-running
// image and returns its output. See:
//   https://developers.cloudflare.com/containers/execute-commands/
//
// The agent-facing wiring (a tool + system-prompt note + an Overseer hook) is tracked as a
// follow-up; this file plus the Dockerfile and wrangler config register the container itself.
// The image (./Dockerfile, relative to wrangler.jsonc) is a generic Node + pnpm + git sandbox,
// so the agent can stream project files in via exec() and then run any language's build tooling.

import { Container } from "@cloudflare/containers";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.container");

/** Result of running a single command in the build container.
 *
 * Mirrors the shared `ContainerRunResult` from @gadgets/workshop-shared/api so the agent tool and the
 * Overseer hook return the same shape without an adapter. */
export type ContainerRunResult = {
  /** Unique id for this run, so an observation can reference it. */
  runId: string;
  /** Process exit code. A nonzero code resolves normally; it is not thrown as an exception. */
  exitCode: number;
  /** Combined standard output and standard error (stderr is merged into stdout via "combined"). */
  output: string;
  /** Unix epoch milliseconds when the run completed. */
  timestamp: number;
};

/** Options for BuildContainer.runCommand. */
export type RunCommandOptions = {
  /** Working directory for the process, relative to the container filesystem. */
  cwd?: string;
  /** Environment additions/overrides for this process. Inherited container env is kept. */
  env?: Record<string, string>;
  /** Whether this run may make outbound internet requests. Defaults to false (the class default);
   *  set true only for commands that need to fetch dependencies from a registry. */
  enableInternet?: boolean;
  /** Hard timeout in milliseconds for the process. If it hasn't finished by then it is killed and
   *  a nonzero exitCode is returned. Defaults to 5 minutes. */
  timeoutMs?: number;
};

/**
 * A build/test sandbox backed by a real Cloudflare Container.
 *
 * The class owns no application state: the container's own disk is ephemeral and resets whenever
 * the instance sleeps (after sleepAfter of inactivity). Persistent state belongs to the caller.
 */
export class BuildContainer extends Container {
  // The image runs a trivial health server on 8080 (see Dockerfile) so the Container class's
  // port-readiness check has something to probe. We never serve real traffic on it; all real
  // work happens via exec().
  defaultPort = 8080;

  // Keep the VM warm briefly between commands so a build -> fix -> rebuild loop doesn't pay the
  // cold-start cost on every call. After this much inactivity the container sleeps and its
  // ephemeral disk is reset, so a later command starts from a clean image.
  sleepAfter = "5m";

  // No outbound internet by default: the agent streams code in via exec(). Set enableInternet
  // (per start, via start options) if a command needs to fetch dependencies from a registry.
  enableInternet = false;

  /**
   * Run a single command inside the container and return its combined output and exit code.
   *
   * exec() starts the executable directly with no shell, so shell features (pipes, redirects,
   * globbing) are unavailable unless you invoke a shell explicitly, e.g.
   * ["bash", "-lc", "pnpm run build 2>&1"]. The container is started on demand if it is not
   * already running.
   */
  async runCommand(command: string[], options: RunCommandOptions = {}): Promise<ContainerRunResult> {
    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    const runId = crypto.randomUUID();

    if (!this.ctx.container.running) {
      // Start the VM, letting this run opt into outbound internet. (Container disk is ephemeral
      // and resets when the instance sleeps after sleepAfter of inactivity.)
      await this.start({ enableInternet: options.enableInternet ?? false });
    }

    const process = await this.ctx.container.exec(command, {
      cwd: options.cwd,
      env: options.env,
      // Merge stderr into stdout so the caller sees errors interleaved with output. This
      // requires stdout: "pipe" (the default).
      stdout: "pipe",
      stderr: "combined",
    });

    // exec() has no built-in timeout, so enforce one ourselves by killing the process. The
    // following await on output() then resolves with the (likely nonzero) exit code.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, timeoutMs);

    let out;
    try {
      out = await process.output();
    } finally {
      clearTimeout(timer);
    }

    const decoder = new TextDecoder();
    return {
      runId,
      exitCode: timedOut ? -1 : out.exitCode ?? -1,
      output: decoder.decode(out.stdout),
      timestamp: Date.now(),
    };
  }

  override onStart(): void {
    logger.info("build container started", { event: "container.build.started" });
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }): void {
    logger.info("build container stopped", { event: "container.build.stopped", exitCode, reason });
  }

  override onError(error: unknown): void {
    logger.error("build container failed to start", { event: "container.build.error", error });
    throw error;
  }
}
