import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { FirebaseManagementApi, type FirebaseProjectResponse } from "./firebase-api";
import type { FirebaseProjectConfiguratorRpc } from "./configurator/firebase-project-configurator-types";

type ConfiguratorOption = { value: string; title: string; subtitle?: string; meta?: string };

const OPTION_LIMIT = 100;

const tokenGetters = new WeakMap<object, () => Promise<string>>();
const projectListCache = new WeakMap<object, Promise<FirebaseProjectResponse[]>>();


function matches(parts: (string | undefined)[], query: string): boolean {
  const lower = query.trim().toLowerCase();
  if (!lower) return true;
  const corpus = parts.filter(Boolean).join(" ").toLowerCase();
  return lower.split(/\s+/).every(term => corpus.includes(term));
}

@validateRpc()
export class FirebaseProjectConfiguratorUI extends RpcTarget implements FirebaseProjectConfiguratorRpc {
  constructor(getToken: () => Promise<string>) {
    super();
    tokenGetters.set(this, getToken);
  }

  async listProjects(query: string): Promise<ConfiguratorOption[]> {
    const getToken = tokenGetters.get(this)!;
    const token = await getToken();
    const mgmt = new FirebaseManagementApi(token);

    let pending = projectListCache.get(this);
    if (!pending) {
      pending = mgmt.listProjects();
      projectListCache.set(this, pending);
      pending.catch(() => projectListCache.delete(this));
    }
    const projects = await pending;

    return projects
      .filter(project => matches([project.displayName, project.projectId], query))
      .slice(0, OPTION_LIMIT)
      .map(project => ({
        value: project.projectId,
        title: project.displayName,
        subtitle: project.projectId,
        meta: project.state ?? "",
      }));
  }
}
