import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { CloudflareApi } from "./cloudflare-api";
import type { CloudflareConfiguratorRpc } from "./configurator/cloudflare-configurator-types";

type ConfiguratorOption = { value: string; title: string; subtitle?: string; meta?: string };

const OPTION_LIMIT = 50;

// Keep the token getter off the RpcTarget's public surface.
const tokenGetters = new WeakMap<object, () => Promise<string>>();

function api(target: object): CloudflareApi {
  const getToken = tokenGetters.get(target);
  if (!getToken) throw new Error("Cloudflare configurator is not initialized.");
  return new CloudflareApi(getToken);
}

function matches(parts: (string | null | undefined)[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const corpus = parts.filter(Boolean).join(" ").toLowerCase();
  return q.split(/\s+/).every(term => corpus.includes(term));
}

@validateRpc()
export class CloudflareConfiguratorUI extends RpcTarget implements CloudflareConfiguratorRpc {
  #kind: string;

  constructor(getToken: () => Promise<string>, kind: string) {
    super();
    tokenGetters.set(this, getToken);
    this.#kind = kind;
  }

  async getResourceKind(): Promise<string> {
    return this.#kind;
  }

  async listAccounts(query: string): Promise<ConfiguratorOption[]> {
    const accounts = await api(this).listAccounts();
    return accounts
      .filter(a => matches([a.id, a.name], query))
      .slice(0, OPTION_LIMIT)
      .map(a => ({ value: a.id, title: a.name, subtitle: "Account id: " + a.id }));
  }

  async listD1Databases(accountId: string, query: string): Promise<ConfiguratorOption[]> {
    const items = await api(this).listD1Databases(accountId);
    return items
      .filter(d => matches([d.uuid, d.name], query))
      .slice(0, OPTION_LIMIT)
      .map(d => ({ value: d.uuid, title: d.name, subtitle: d.uuid }));
  }

  async listR2Buckets(accountId: string, query: string): Promise<ConfiguratorOption[]> {
    const items = await api(this).listR2Buckets(accountId);
    return items
      .filter(b => matches([b.name], query))
      .slice(0, OPTION_LIMIT)
      .map(b => ({ value: b.name, title: b.name }));
  }

  async listZones(accountId: string, query: string): Promise<ConfiguratorOption[]> {
    const items = await api(this).listZones(accountId, 1);
    return items.result
      .filter(z => matches([z.id, z.name], query))
      .slice(0, OPTION_LIMIT)
      .map(z => ({ value: z.id, title: z.name, subtitle: "Zone id: " + z.id, meta: z.status }));
  }

  async listWorkers(accountId: string, query: string): Promise<ConfiguratorOption[]> {
    const items = await api(this).listWorkers(accountId);
    return items
      .filter(w => matches([w.id], query))
      .slice(0, OPTION_LIMIT)
      .map(w => ({ value: w.id, title: w.id }));
  }

  async listPagesProjects(accountId: string, query: string): Promise<ConfiguratorOption[]> {
    const items = await api(this).listPagesProjects(accountId);
    return items
      .filter(p => matches([p.name, p.subdomain], query))
      .slice(0, OPTION_LIMIT)
      .map(p => ({ value: p.name, title: p.name, subtitle: p.subdomain ? "pages.dev/" + p.subdomain : undefined }));
  }

  async listVectorIndexes(accountId: string, query: string): Promise<ConfiguratorOption[]> {
    const items = await api(this).listVectorIndexes(accountId);
    return items
      .filter(v => matches([v.name, v.description], query))
      .slice(0, OPTION_LIMIT)
      .map(v => ({ value: v.name, title: v.name, subtitle: v.description }));
  }

  async listTunnels(accountId: string, query: string): Promise<ConfiguratorOption[]> {
    const items = await api(this).listTunnels(accountId);
    return items
      .filter(t => matches([t.id, t.name], query))
      .slice(0, OPTION_LIMIT)
      .map(t => ({ value: t.id, title: t.name, subtitle: "Tunnel id: " + t.id }));
  }
}
