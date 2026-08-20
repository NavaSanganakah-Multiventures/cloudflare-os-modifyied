import { Autocomplete, Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubRepoConfiguratorRpc, GitHubRepoConfiguratorValues } from "./github-repo-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.repoFullName === "string" && values.repoFullName.length > 0;
  },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const [owner, repo] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const repoFullName = owner && repo ? `${owner}/${repo}` : null;
    if (!repoFullName) return {};
    const saved = await ui.getSavedBuildExecutor(repoFullName);
    return {
      repoFullName,
      buildExecutor: saved ?? "auto",
    };
  },

  resourceUrl({ values }) {
    return `https://github.com/${values.repoFullName}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Repository" description="Search your repositories, or enter a GitHub URL.">
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder="Search or paste a repository URL..."
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName })}
        />
      </Field>
      <Field
        label="Build executor"
        description="Choose how proposed code changes are built and tested. Defaults to GitHub Actions for public repos and Cloudflare Containers for private repos."
      >
        <RadioCards
          value={values.buildExecutor ?? "auto"}
          options={[
            {
              value: "auto",
              title: "Auto (default)",
              description: "Public repos use GitHub Actions; private repos use Cloudflare Containers.",
            },
            {
              value: "githubActions",
              title: "GitHub Actions",
              description: "Build and test using GitHub Actions runners.",
            },
            {
              value: "cloudflareContainers",
              title: "Cloudflare Containers",
              description: "Build and test inside a Cloudflare container.",
            },
          ]}
          onChange={async (buildExecutor) => {
            setValues({ buildExecutor });
            if (values.repoFullName) {
              await ui.saveBuildExecutor(values.repoFullName, buildExecutor === "auto" ? null : buildExecutor);
            }
          }}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubRepoConfiguratorRpc, GitHubRepoConfiguratorValues>;
