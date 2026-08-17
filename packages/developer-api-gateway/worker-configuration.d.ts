interface Env {
  DEVELOPER_API_GATEWAY: DurableObjectNamespace<unknown>;
  GITHUB_TOKEN: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  EMAIL?: unknown;
  CALLBACK_SECRET?: string;
}
