import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import capnwebValidate from "capnweb-validate/vite";

// `cloudflare:workers` is a Cloudflare runtime module resolved only inside workerd. The catalog
// test imports the gatekeeper, which pulls it in at module load, so alias it to a minimal shim that
// lets stateless unit tests run under node/vitest. Tests needing real runtime behavior should use
// @cloudflare/vitest-pool-workers (as backend-utils/workshop-backend do).
//
// The capnwebValidate() plugin transforms the `@validateRpc()` decorators the gatekeeper uses;
// without it those decorators throw "called before it was transformed" at import time.
export default defineConfig({
  plugins: [capnwebValidate()],
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./__tests__/cloudflare-workers-shim.ts", import.meta.url)),
    },
  },
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
  },
});
