import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    alias: [
      // The `cloudflare:workers` module only exists inside workerd. This stub provides the base
      // classes (DurableObject / RpcTarget / WorkerEntrypoint / RpcStub) so modules that declare a
      // Durable Object or an RpcTarget can be imported at all under plain vitest. Anything that
      // actually needs the runtime belongs in a Workers-pool test, not here.
      {
        find: "cloudflare:workers",
        replacement: fileURLToPath(new URL("./__tests__/stubs/cloudflare-workers.ts", import.meta.url)),
      },
      // github.ts imports the generated configurator UI bundles (built by `build:configurator` and
      // gitignored) and the vendor logo SVG as default-exported text modules at module top level.
      // They are irrelevant to these unit tests and the .txt bundles cannot be loaded as JS by vite
      // in the node environment, so resolve them to an empty string and let the module graph load
      // without depending on the build step.
      {
        find: /[\\/]generated[\\/][^\\/]+-configurator-ui\.txt$/,
        replacement: fileURLToPath(new URL("./__tests__/stubs/empty-string.ts", import.meta.url)),
      },
      {
        find: /github-logo\.svg$/,
        replacement: fileURLToPath(new URL("./__tests__/stubs/empty-string.ts", import.meta.url)),
      },
      {
        find: /(^|[\\/])types\.txt$/,
        replacement: fileURLToPath(new URL("./__tests__/stubs/empty-string.ts", import.meta.url)),
      },
    ],
  },
});
