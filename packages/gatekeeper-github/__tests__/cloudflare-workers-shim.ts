// Minimal stub of the `cloudflare:workers` runtime module so unit tests that only exercise
// stateless methods (e.g. the auto-approval action catalog in getAutoApprovableActions) can import
// the gatekeeper under node/vitest without the Workers runtime. Tests that need real runtime
// behavior should run under @cloudflare/vitest-pool-workers instead.
//
// These intentionally-empty base classes stand in for the runtime's DurableObject/WorkerEntrypoint/
// RpcTarget: subclasses extend them and forward constructor args (e.g. fake state/env), which the
// empty classes simply accept and ignore. RpcStub is used only as a type in the gatekeeper, so a
// bare class satisfies the value import.

/* eslint-disable typescript/no-extraneous-class -- intentional empty shim base classes */

export class DurableObject {}

export class WorkerEntrypoint {}

export class RpcTarget {}

export class RpcStub {}
