// A minimal "text module" stand-in for vitest. github.ts imports generated configurator UI bundles
// (`.txt`) and the vendor logo (`.svg`) as default-exported strings at module top level. Those files
// are build artifacts / assets that vite cannot load as JS in the node test environment, so the
// vitest config aliases them to this module so the module graph still loads. Their values are
// irrelevant to the unit tests in this package.
export default "";
