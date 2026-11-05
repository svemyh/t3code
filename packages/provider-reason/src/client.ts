import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { ReasonSettings } from "./settings.ts";

// Reason's mark: a hexagon with two upright eyes (reasonmachines.com/favicon.svg),
// with the eyes' round-capped strokes drawn as capsules.
const HEXAGON =
  "M95 43.1Q99 50 95 56.9L78.5 85.5Q74.5 92.4 66.5 92.4L33.5 92.4Q25.5 92.4 21.5 85.5L5 56.9Q1 50 5 43.1L21.5 14.5Q25.5 7.6 33.5 7.6L66.5 7.6Q74.5 7.6 78.5 14.5Z";
const LEFT_EYE = "M48.75 29.5A4.5 4.5 0 0 1 57.75 29.5V50.5A4.5 4.5 0 0 1 48.75 50.5Z";
const RIGHT_EYE = "M66.25 29.5A4.5 4.5 0 0 1 75.25 29.5V50.5A4.5 4.5 0 0 1 66.25 50.5Z";

export const reasonClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("reason"),
  label: "Reason",
  settingsSchema: ReasonSettings,
  environmentFields: [
    {
      name: "REASON_API_KEY",
      label: "Reason API key",
      description: "Optional. Signs in without `reason login`. Create one at reasonmachines.com.",
      placeholder: "reason_…",
      sensitive: true,
    },
  ],
  icon: {
    viewBox: "0 0 100 100",
    fill: { light: "#14120B", dark: "#F4F3EF" },
    // The eyes are holes in the hexagon, so the monochrome icon still shows them.
    paths: [{ d: `${HEXAGON}${LEFT_EYE}${RIGHT_EYE}`, fillRule: "evenodd" }],
  },
});
