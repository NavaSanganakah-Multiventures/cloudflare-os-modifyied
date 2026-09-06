import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  JulesAccountConfiguratorRpc,
  JulesAccountConfiguratorValues,
} from "./account-configurator-types";

// The account resource has no user-selectable inputs: once the user has connected an account,
// the resource URL is fully determined. The configurator displays a confirmation and signals
// readiness.

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return <Section>
      <Field
        label="Google Jules account"
        description="This binding grants access to your connected Google Jules account: sources, sessions, plans, and pull requests." />
    </Section>;
  },
} satisfies ConfiguratorUISpec<JulesAccountConfiguratorRpc, JulesAccountConfiguratorValues>;
