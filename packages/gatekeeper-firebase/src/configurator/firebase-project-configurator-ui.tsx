import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { FirebaseProjectConfiguratorRpc, FirebaseProjectConfiguratorValues } from "./firebase-project-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.projectId === "string" && values.projectId.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const values: { projectId?: string } = {};
    if (segments[0] === "project" && segments[1]) {
      values.projectId = decodeURIComponent(segments[1]);
    }
    return values;
  },

  resourceUrl({ values }) {
    const projectId = values.projectId
      ? encodeURIComponent(values.projectId)
      : "";
    return `https://console.firebase.google.com/project/${projectId}/`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Project" description="Choose the Firebase project this connection can access.">
        <Autocomplete
          name="projectId"
          value={values.projectId}
          placeholder="Search Firebase projects..."
          loadOptions={query => ui.listProjects(query)}
          onChange={projectId => {
            setValues({ projectId: projectId ?? null });
          }}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<FirebaseProjectConfiguratorRpc, FirebaseProjectConfiguratorValues>;
