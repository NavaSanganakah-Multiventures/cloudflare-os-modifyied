import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  AstrologyAccountConfiguratorRpc,
  AstrologyAccountConfiguratorValues,
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
        label="Astrology API account"
        description="This binding grants access to your connected Navasanganakah Astrology API account: birth charts, dashas, transits, panchang, and Hindi Kundli analysis." />
    </Section>;
  },
} satisfies ConfiguratorUISpec<AstrologyAccountConfiguratorRpc, AstrologyAccountConfiguratorValues>;
