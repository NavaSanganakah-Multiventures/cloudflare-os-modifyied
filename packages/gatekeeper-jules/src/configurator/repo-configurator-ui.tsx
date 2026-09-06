import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { JulesRepoConfiguratorRpc, JulesRepoConfiguratorValues } from "./repo-configurator-types";

export default {
  initial: {},

  async initialValuesFromResourceUrl({ resourceUrl }) {
    try {
      const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
      if (segments[0] === "sources" && segments.length >= 2) {
        return { sourceName: "sources/" + decodeURIComponent(segments[1]) };
      }
    } catch {
      // Ignore malformed URLs; leave the form blank.
    }
    return {};
  },

  isReady({ values }) {
    return typeof values.sourceName === "string" && values.sourceName.length > 0;
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.sourceName);
  },

  render({ values, setValues, ui }) {
    return (
      <Section>
        <Field
          label="Repository"
          description="Choose a GitHub repository connected to your Google Jules account."
        >
          <Autocomplete
            name="sourceName"
            value={values.sourceName}
            placeholder="Search repositories..."
            loadOptions={query => ui.listSources(query)}
            onChange={sourceName => setValues({ sourceName })}
          />
        </Field>
      </Section>
    );
  },
} satisfies ConfiguratorUISpec<JulesRepoConfiguratorRpc, JulesRepoConfiguratorValues>;
