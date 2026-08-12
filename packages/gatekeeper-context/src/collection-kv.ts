// KV helpers for the per-domain public-collections snapshot. The registry DO is the only writer;
// user sessions read it when building their enabled collection set.

import { ContextCollectionMetadata, ContextCollectionSummary } from "./context-types.js";

// Namespaces sharing domains; NUL never appears in configured domains.
const KV_SEP = "\u0000";

// A domain's public-collections snapshot.
export function publicCollectionsKvKey(domain: string): string {
  return `${domain}${KV_SEP}.public`;
}

// Parse the public-collections KV snapshot. The registry DO is the only intended writer and
// always stores a JSON array, but the KV namespace is shared infrastructure: a corrupt, stale, or
// foreign value at the snapshot key must not throw and break Context & Skills for every reader in
// the domain. Treat any unreadable or non-array snapshot as "no public collections" and carry on.
function parsePublicCollections(raw: string): ContextCollectionSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("Context Library: ignoring unreadable public-collections KV snapshot.", { raw });
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn("Context Library: ignoring non-array public-collections KV snapshot.", { raw });
    return [];
  }
  const result: ContextCollectionSummary[] = [];
  for (const entry of parsed) {
    if (entry && typeof entry.id === 'string' && typeof entry.title === 'string' &&
        (entry.documentCount === undefined || typeof entry.documentCount === 'number') &&
        (entry.lastUpdated === undefined || typeof entry.lastUpdated === 'string' || entry.lastUpdated instanceof Date)) {
      result.push({
        ...entry,
        lastUpdated: entry.lastUpdated ? new Date(entry.lastUpdated) : new Date(),
      });
    } else {
      console.warn("Context Library: ignoring malformed public-collections KV entry.", { entry });
    }
  }
  return result;
}

// The public collections for a domain (readable by every user in that domain).
export async function listPublicCollectionsFromKv(
  env: Pick<Cloudflare.Env, 'CONTEXT_COLLECTIONS'>,
  domain: string,
): Promise<ContextCollectionSummary[]> {
  let raw = await env.CONTEXT_COLLECTIONS.get(publicCollectionsKvKey(domain));
  if (!raw) {
    return [];
  }
  return parsePublicCollections(raw);
}

export function metadataToSummary(metadata: ContextCollectionMetadata): ContextCollectionSummary {
  return {
    id: metadata.id,
    title: metadata.title,
    description: metadata.description,
    icon: metadata.icon,
    visibility: metadata.visibility,
    documentCount: metadata.documentCount,
    lastUpdated: metadata.lastUpdated,
  };
}
