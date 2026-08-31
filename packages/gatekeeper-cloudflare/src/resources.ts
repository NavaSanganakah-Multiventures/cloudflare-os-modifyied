// Resource catalog for the Cloudflare gatekeeper: the URL patterns it can resolve, the OAuth
// scopes needed for each capability, and helpers to parse canonical dashboard URLs.

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import {
  AI_SCOPES,
  BASE_SCOPES,
  D1_SCOPES,
  EMAIL_SCOPES,
  PAGES_SCOPES,
  R2_SCOPES,
  TUNNEL_SCOPES,
  VECTORIZE_SCOPES,
  WORKERS_SCOPES,
  ZONE_SCOPES,
} from "./oauth.js";

export type ResourceKind =
  | "account"
  | "ai"
  | "d1"
  | "r2"
  | "zone"
  | "email"
  | "worker"
  | "pages"
  | "vector"
  | "tunnel";

export interface ParsedResourceUrl {
  kind: ResourceKind;
  accountId: string;
  resourceId: string | null;
}

// Canonical URL patterns. These are what agents bind to (and what the configurator emits); they do
// not attempt to mirror every dashboard deep-link.
export const ACCOUNT_PATTERN = "https://dash.cloudflare.com/:accountId";
export const AI_PATTERN = "https://dash.cloudflare.com/:accountId/ai";
export const D1_PATTERN = "https://dash.cloudflare.com/:accountId/d1/:databaseId";
export const R2_PATTERN = "https://dash.cloudflare.com/:accountId/r2/:bucketName";
export const ZONE_PATTERN = "https://dash.cloudflare.com/:accountId/dns/:zoneId";
export const EMAIL_PATTERN = "https://dash.cloudflare.com/:accountId/email/:zoneId";
export const WORKER_PATTERN = "https://dash.cloudflare.com/:accountId/workers/:scriptName";
export const PAGES_PATTERN = "https://dash.cloudflare.com/:accountId/pages/:projectName";
export const VECTOR_PATTERN = "https://dash.cloudflare.com/:accountId/vectorize/:indexName";
export const TUNNEL_PATTERN = "https://dash.cloudflare.com/:accountId/tunnels/:tunnelId";

export const SUPPORTED_RESOURCES: SupportedResource[] = [
  {
    urlPattern: ACCOUNT_PATTERN,
    title: "Cloudflare account",
    description: "Everything under one Cloudflare account: zones, D1, R2, Workers, Pages, AI, Vectorize, Tunnels and email routing.",
    icon: "cloudflare",
    grantable: true,
  },
  {
    urlPattern: D1_PATTERN,
    title: "Cloudflare D1 database",
    description: "A serverless SQLite database (query + execute SQL, inspect tables).",
    icon: "d1",
    grantable: true,
  },
  {
    urlPattern: R2_PATTERN,
    title: "Cloudflare R2 bucket",
    description: "Object storage bucket (bucket management via the REST API; object reads/writes require S3 credentials).",
    icon: "r2",
    grantable: true,
  },
  {
    urlPattern: ZONE_PATTERN,
    title: "Cloudflare DNS zone",
    description: "A DNS zone: manage DNS records and zone metadata.",
    icon: "dns",
    grantable: true,
  },
  {
    urlPattern: WORKER_PATTERN,
    title: "Cloudflare Worker",
    description: "A Workers script: read/update/delete the deployed script.",
    icon: "workers",
    grantable: true,
  },
  {
    urlPattern: PAGES_PATTERN,
    title: "Cloudflare Pages project",
    description: "A Pages project: inspect project metadata and deployments.",
    icon: "pages",
    grantable: true,
  },
  {
    urlPattern: AI_PATTERN,
    title: "Cloudflare AI",
    description: "Workers AI: run inference against a model and list available models.",
    icon: "ai",
    grantable: true,
  },
  {
    urlPattern: VECTOR_PATTERN,
    title: "Cloudflare Vectorize index",
    description: "A vector database index: query and upsert vectors.",
    icon: "vectorize",
    grantable: true,
  },
  {
    urlPattern: EMAIL_PATTERN,
    title: "Cloudflare Email Routing zone",
    description: "Email routing for a zone: rules, destinations and routing status.",
    icon: "email",
    grantable: true,
  },
  {
    urlPattern: TUNNEL_PATTERN,
    title: "Cloudflare Tunnel",
    description: "A Cloudflare Tunnel: inspect tunnel metadata and connections.",
    icon: "tunnel",
    grantable: true,
  },
];

const SEGMENT_TO_KIND: Record<string, ResourceKind> = {
  ai: "ai",
  d1: "d1",
  r2: "r2",
  dns: "zone",
  email: "email",
  workers: "worker",
  pages: "pages",
  vectorize: "vector",
  tunnels: "tunnel",
};

const PATTERN_TO_KIND: Record<string, ResourceKind> = {
  [ACCOUNT_PATTERN]: "account",
  [AI_PATTERN]: "ai",
  [D1_PATTERN]: "d1",
  [R2_PATTERN]: "r2",
  [ZONE_PATTERN]: "zone",
  [EMAIL_PATTERN]: "email",
  [WORKER_PATTERN]: "worker",
  [PAGES_PATTERN]: "pages",
  [VECTOR_PATTERN]: "vector",
  [TUNNEL_PATTERN]: "tunnel",
};

export function resourceKindOfUrlPattern(urlPattern: string): ResourceKind | null {
  return PATTERN_TO_KIND[urlPattern] ?? null;
}

export function parseResourceUrl(url: string): ParsedResourceUrl | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== "dash.cloudflare.com") return null;

  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const accountId = segments[0];

  if (segments.length === 1) return { kind: "account", accountId, resourceId: null };

  const kind = SEGMENT_TO_KIND[segments[1]];
  if (!kind || segments.length < 3) return null;
  return { kind, accountId, resourceId: decodeURIComponent(segments[2]) };
}

// Scopes required by each capability. Account connections require the union of all capability
// scopes, since the account session can list/act on every service.
const KIND_SCOPES: Record<ResourceKind, string[]> = {
  account: [
    ...D1_SCOPES,
    ...R2_SCOPES,
    ...ZONE_SCOPES,
    ...WORKERS_SCOPES,
    ...PAGES_SCOPES,
    ...AI_SCOPES,
    ...VECTORIZE_SCOPES,
    ...EMAIL_SCOPES,
    ...TUNNEL_SCOPES,
  ],
  ai: AI_SCOPES,
  d1: D1_SCOPES,
  r2: R2_SCOPES,
  zone: ZONE_SCOPES,
  email: EMAIL_SCOPES,
  worker: WORKERS_SCOPES,
  pages: PAGES_SCOPES,
  vector: VECTORIZE_SCOPES,
  tunnel: TUNNEL_SCOPES,
};

export function scopesForResourceKinds(kinds: ResourceKind[]): string[] {
  const scopes = new Set<string>(BASE_SCOPES);
  for (const kind of kinds) {
    for (const s of KIND_SCOPES[kind]) scopes.add(s);
  }
  return [...scopes];
}

export function scopesForResourceUrlPatterns(urlPatterns: string[]): string[] {
  const kinds = urlPatterns
    .map(p => resourceKindOfUrlPattern(p))
    .filter((k): k is ResourceKind => k !== null);
  return scopesForResourceKinds(kinds);
}

// Build a canonical resource URL (used by the configurator).
export function buildResourceUrl(kind: ResourceKind, accountId: string, resourceId?: string): string {
  switch (kind) {
    case "account": return `https://dash.cloudflare.com/${accountId}`;
    case "ai": return `https://dash.cloudflare.com/${accountId}/ai`;
    case "d1": return `https://dash.cloudflare.com/${accountId}/d1/${resourceId}`;
    case "r2": return `https://dash.cloudflare.com/${accountId}/r2/${encodeURIComponent(resourceId ?? "")}`;
    case "zone": return `https://dash.cloudflare.com/${accountId}/dns/${resourceId}`;
    case "email": return `https://dash.cloudflare.com/${accountId}/email/${resourceId}`;
    case "worker": return `https://dash.cloudflare.com/${accountId}/workers/${encodeURIComponent(resourceId ?? "")}`;
    case "pages": return `https://dash.cloudflare.com/${accountId}/pages/${encodeURIComponent(resourceId ?? "")}`;
    case "vector": return `https://dash.cloudflare.com/${accountId}/vectorize/${encodeURIComponent(resourceId ?? "")}`;
    case "tunnel": return `https://dash.cloudflare.com/${accountId}/tunnels/${resourceId}`;
  }
}
