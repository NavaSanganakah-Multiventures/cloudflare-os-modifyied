export type JulesAccountConfiguratorValues = {
  // No user-selectable values: the configurator simply confirms the account.
  confirmed?: string | null;
};

export interface JulesAccountConfiguratorRpc {
  // Returns the canonical resource URL for the connected Google Jules account.
  resourceUrl(): Promise<string>;

  // Returns a human-readable description of the connected account.
  describeAccount(): Promise<{ name: string; url: string }>;
}
