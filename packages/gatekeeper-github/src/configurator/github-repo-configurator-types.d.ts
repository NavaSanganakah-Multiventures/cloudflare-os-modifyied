export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

export type GitHubRepoConfiguratorValues = {
  repoFullName?: string | null;
  buildExecutor?: string | null;
}

export interface GitHubRepoConfiguratorRpc {
  listRepos(query: string): Promise<ConfiguratorOption[]>;
  getSavedBuildExecutor(repoFullName: string): Promise<string | null>;
  saveBuildExecutor(repoFullName: string, buildExecutor: string | null): Promise<void>;
}
