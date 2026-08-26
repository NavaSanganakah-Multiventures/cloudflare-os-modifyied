export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

export type FirebaseProjectConfiguratorValues = {
  /** The selected Firebase project ID. Matches the `:projectId` group of the resource URL pattern. */
  projectId?: string | null;
}

export interface FirebaseProjectConfiguratorRpc {
  /** Searches the connected account's Firebase projects. Returns options whose `value` is a project ID. */
  listProjects(query: string): Promise<ConfiguratorOption[]>;
}
