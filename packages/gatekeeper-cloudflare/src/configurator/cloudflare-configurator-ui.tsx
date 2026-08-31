import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ConfiguratorOption,
  CloudflareConfiguratorRpc,
  CloudflareConfiguratorValues,
} from "./cloudflare-configurator-types";

// Resource kinds that present a second (resource) autocomplete. Account and Workers AI are
// account-scoped and only need the account picker.
const RESOURCE_LABELS: Record<string, string> = {
  d1: "D1 database",
  r2: "R2 bucket",
  zone: "DNS zone",
  email: "Email Routing zone",
  worker: "Worker",
  pages: "Pages project",
  vector: "Vectorize index",
  tunnel: "Tunnel",
};

type ResourceList = (ui: CloudflareConfiguratorRpc, accountId: string, query: string) => Promise<ConfiguratorOption[]>;

const RESOURCE_LISTS: Record<string, ResourceList> = {
  d1: (ui, accountId, query) => ui.listD1Databases(accountId, query),
  r2: (ui, accountId, query) => ui.listR2Buckets(accountId, query),
  zone: (ui, accountId, query) => ui.listZones(accountId, query),
  email: (ui, accountId, query) => ui.listZones(accountId, query),
  worker: (ui, accountId, query) => ui.listWorkers(accountId, query),
  pages: (ui, accountId, query) => ui.listPagesProjects(accountId, query),
  vector: (ui, accountId, query) => ui.listVectorIndexes(accountId, query),
  tunnel: (ui, accountId, query) => ui.listTunnels(accountId, query),
};

let kindPromise: Promise<string> | null = null;
let kindValue: string | null = null;

function getKind(ui: CloudflareConfiguratorRpc): Promise<string> {
  if (!kindPromise) {
    kindPromise = ui.getResourceKind().then(kind => {
      kindValue = kind;
      return kind;
    });
  }
  return kindPromise;
}

function buildUrl(kind: string, accountId: string, resourceId?: string): string {
  switch (kind) {
    case "account": return "https://dash.cloudflare.com/" + accountId;
    case "ai": return "https://dash.cloudflare.com/" + accountId + "/ai";
    case "d1": return "https://dash.cloudflare.com/" + accountId + "/d1/" + resourceId;
    case "r2": return "https://dash.cloudflare.com/" + accountId + "/r2/" + encodeURIComponent(resourceId ?? "");
    case "zone": return "https://dash.cloudflare.com/" + accountId + "/dns/" + resourceId;
    case "email": return "https://dash.cloudflare.com/" + accountId + "/email/" + resourceId;
    case "worker": return "https://dash.cloudflare.com/" + accountId + "/workers/" + encodeURIComponent(resourceId ?? "");
    case "pages": return "https://dash.cloudflare.com/" + accountId + "/pages/" + encodeURIComponent(resourceId ?? "");
    case "vector": return "https://dash.cloudflare.com/" + accountId + "/vectorize/" + encodeURIComponent(resourceId ?? "");
    case "tunnel": return "https://dash.cloudflare.com/" + accountId + "/tunnels/" + resourceId;
  }
  return "https://dash.cloudflare.com/" + accountId;
}

export default {
  initial: {},

  isReady({ values }) {
    if (typeof values.accountId !== "string" || values.accountId.length === 0) return false;
    if (kindValue === "account" || kindValue === "ai") return true;
    return typeof values.resourceId === "string" && values.resourceId.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const u = new URL(resourceUrl);
    const segments = u.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return {};
    const out: CloudflareConfiguratorValues = { accountId: segments[0] };
    if (segments.length >= 3) out.resourceId = decodeURIComponent(segments[2]);
    return out;
  },

  async resourceUrl({ values, ui }) {
    const kind = await getKind(ui);
    const accountId = values.accountId ?? "";
    return buildUrl(kind, accountId, values.resourceId ?? undefined);
  },

  render({ values, setValues, ui }) {
    if (!kindValue) {
      getKind(ui).then(() => setValues({}));
      return <Section />;
    }
    const kind = kindValue;
    const needsResource = kind !== "account" && kind !== "ai";
    const listResources = RESOURCE_LISTS[kind];
    return (
      <Section>
        <Field label="Account" description="The Cloudflare account this resource lives in.">
          <Autocomplete
            name="accountId"
            value={values.accountId}
            placeholder="Select an account..."
            loadOptions={(query: string) => ui.listAccounts(query)}
            onChange={(accountId: string | null) => setValues({ accountId, resourceId: null })}
          />
        </Field>
        {needsResource && listResources ? (
          <Field label={RESOURCE_LABELS[kind] ?? "Resource"} description="The specific resource to grant access to.">
            <Autocomplete
              name="resourceId"
              value={values.resourceId}
              placeholder={"Select a " + (RESOURCE_LABELS[kind] ?? "resource") + "..."}
              loadOptions={(query: string) => listResources(ui, values.accountId ?? "", query)}
              onChange={(resourceId: string | null) => setValues({ resourceId })}
            />
          </Field>
        ) : null}
      </Section>
    );
  },
} satisfies ConfiguratorUISpec<CloudflareConfiguratorRpc, CloudflareConfiguratorValues>;
