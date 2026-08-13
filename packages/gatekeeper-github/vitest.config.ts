import { fileURLToPath } from "node:url";
import { defineConfig, type PluginOption } from "vitest/config";

// Stand-in for the `cloudflare:workers` module (only exists inside workerd) and for the generated
// configurator UI / logo / type-text modules that github.ts imports at module top level, so the
// gatekeeper-github unit tests can load github.ts under plain vitest (node environment) without
// workerd or the `build:configurator` build step.

const cloudflareWorkersStub = fileURLToPath(
  new URL("./__tests__/stubs/cloudflare-workers.ts", import.meta.url),
);
const emptyStringStub = fileURLToPath(
  new URL("./__tests__/stubs/empty-string.ts", import.meta.url),
);

// github.ts imports the generated `*-configurator-ui.txt` bundles (built by `build:configurator`
// and gitignored), the vendor logo SVG, and `types.txt` as default-exported text modules at module
// top level. Their values are unused by these unit tests, and the `.txt` bundles are build
// artifacts that vite cannot load as JS in the node environment, so redirect those imports to the
// empty-string stub. Returning a full absolute path (rather than rewriting the specifier via a
// regex alias, which would mangle the resolved path) keeps resolution clean.
function stubTextModules(): PluginOption {
  return {
    name: "gadgets-github:stub-text-modules",
    resolveId(source) {
      if (
        source.endsWith("-configurator-ui.txt") ||
        source === "./types.txt" ||
        source.endsWith("github-logo.svg")
      ) {
        return emptyStringStub;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [stubTextModules()],
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    alias: {
      // Provides DurableObject / RpcTarget / WorkerEntrypoint / RpcStub so modules that declare a
      // Durable Object or RpcTarget can be imported at all under plain vitest. Anything that
      // actually needs the runtime belongs in a Workers-pool test, not here.
      "cloudflare:workers": cloudflareWorkersStub,
    },
  },
});
