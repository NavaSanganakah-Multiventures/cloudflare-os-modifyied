import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

/** Observability fields emitted by the Firebase gatekeeper. */
export type FirebaseObservabilityFields = { vendorId: string };

/** Ambient observability fields for one Firebase gatekeeper operation. */
export const obsContext = createObservabilityContext<FirebaseObservabilityFields>();
