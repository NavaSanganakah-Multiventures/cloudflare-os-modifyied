export type JulesConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type JulesRepoConfiguratorValues = {
  /** Full source resource name, e.g. "sources/<id>". */
  sourceName?: string | null;
};

export interface JulesRepoConfiguratorRpc {
  listSources(query: string): Promise<JulesConfiguratorOption[]>;
  resourceUrl(sourceName: string | null | undefined): Promise<string>;
}
