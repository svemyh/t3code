import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { ReasonSettings } from "./settings.ts";

const TILE =
  "M260 0H940A260 260 0 0 1 1200 260V940A260 260 0 0 1 940 1200H260A260 260 0 0 1 0 940V260A260 260 0 0 1 260 0Z";
// A block "R", cut out of the tile so a monochrome icon still reads.
const LETTER =
  "M380 300H660C780 300 860 380 860 490C860 575 812 640 738 667L880 900H740L612 680H500V900H380ZM500 410V575H650C710 575 740 540 740 492C740 445 710 410 650 410Z";

export const reasonClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("reason"),
  label: "Reason",
  featured: false,
  badgeLabel: "Early Access",
  settingsSchema: ReasonSettings,
  environmentFields: [
    {
      name: "REASON_API_KEY",
      label: "Reason API key",
      description:
        "Optional. Uses a Reason API key (reasonmachines.com › Settings › API) instead of `reason login`.",
      placeholder: "Paste API key",
      sensitive: true,
    },
  ],
  icon: {
    viewBox: "0 0 1200 1200",
    fill: { light: "#111111", dark: "#F5F5F5" },
    paths: [{ d: `${TILE}${LETTER}`, fillRule: "evenodd" }],
  },
});
