# @gadgets/build-runner

Cloudflare Containers-based build runner for the Aarya Smart GitHub gatekeeper.

This package builds a container image that includes:

- Flutter SDK
- Android command-line tools
- C/C++ toolchain (`build-essential`, `cmake`, `clang`, `ninja-build`)

The gatekeeper can invoke `BuildRunner.runBuild()` to clone a repository branch
and execute arbitrary shell commands inside the container.

## Usage

Deploy the worker:

    pnpm --filter @gadgets/build-runner deploy

Then wire it into the GitHub gatekeeper with a service binding named `BUILD_RUNNER`.

## Security notes

- The container clones private repositories using a short-lived access token embedded
  in the HTTPS URL. The token is passed only over Cloudflare internal RPC network,
  but container stdout/stderr may include the URL. Treat build logs as sensitive.
- Each build runs in a fresh temporary directory inside the container; nothing persists
  between builds except the container image.
- For production, consider replacing token-in-URL with a git credential helper that
  reads from a short-lived environment variable.
