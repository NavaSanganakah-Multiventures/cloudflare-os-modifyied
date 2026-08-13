// No-op stand-in for the capnweb-validate runtime decorators.
//
// capnweb-validate's real validation is a *build-time* transform applied by its vite/esbuild
// plugin. The untransformed runtime exports throw ("decorator was called before it was
// transformed") the moment @validateRpc() is applied to a class, so under plain vitest (which does
// not run that transform) we replace the module with no-op decorators. This lets modules that use
// @validateRpc() / @skipRpcValidation() load; their validation behaviour is irrelevant to these
// unit tests.

function noopDecorator(target: any, _key?: any, descriptor?: any) {
  return descriptor ?? target;
}

// Supports both the factory form (@validateRpc()) and the direct form (@validateRpc).
export function validateRpc(...args: any[]) {
  if (args.length === 0) return noopDecorator;
  return noopDecorator(...args);
}

export function skipRpcValidation(...args: any[]) {
  if (args.length === 0) return noopDecorator;
  return noopDecorator(...args);
}

export function validateStub(_stub: any) {
  // no-op in tests
}
