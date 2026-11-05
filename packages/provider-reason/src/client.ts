import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { ReasonSettings } from "./settings.ts";

export const reasonClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("reason"),
  label: "Reason",
  featured: true,
  settingsSchema: ReasonSettings,
  environmentFields: [
    {
      name: "REASON_API_KEY",
      label: "Reason API key",
      description: "Optional. Signs in without `reason login`.",
      placeholder: "Paste API key",
      sensitive: true,
    },
  ],
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#000000", dark: "#FFFFFF" },
    paths: [
      {
        // A rounded "R" mark.
        d: "M6 3h7.5a5.5 5.5 0 0 1 2.1 10.58L19.5 21h-3.4l-3.5-7H9v7H6V3Zm3 3v5h4.5a2.5 2.5 0 0 0 0-5H9Z",
        fillRule: "evenodd",
      },
    ],
  },
});
