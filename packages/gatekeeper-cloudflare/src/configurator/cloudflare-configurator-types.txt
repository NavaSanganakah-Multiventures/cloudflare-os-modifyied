export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

export type CloudflareConfiguratorValues = {
  accountId?: string | null;
  resourceId?: string | null;
}

export interface CloudflareConfiguratorRpc {
  getResourceKind(): Promise<string>;
  listAccounts(query: string): Promise<ConfiguratorOption[]>;
  listD1Databases(accountId: string, query: string): Promise<ConfiguratorOption[]>;
  listR2Buckets(accountId: string, query: string): Promise<ConfiguratorOption[]>;
  listZones(accountId: string, query: string): Promise<ConfiguratorOption[]>;
  listWorkers(accountId: string, query: string): Promise<ConfiguratorOption[]>;
  listPagesProjects(accountId: string, query: string): Promise<ConfiguratorOption[]>;
  listVectorIndexes(accountId: string, query: string): Promise<ConfiguratorOption[]>;
  listTunnels(accountId: string, query: string): Promise<ConfiguratorOption[]>;
}
