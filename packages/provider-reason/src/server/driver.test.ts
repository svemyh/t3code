import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ReasonSettings } from "../settings.ts";
import { buildReasonAcpSpawnInput } from "./acpSupport.ts";
import { reasonAuthFromWhoami } from "./status.ts";

const decodeSettings = Schema.decodeUnknownSync(ReasonSettings);

describe("ReasonDriver", () => {
  it("launches the V3 ACP engine with CLI-owned auth from the configured binary", () => {
    assert.deepEqual(buildReasonAcpSpawnInput(decodeSettings({}), "/work"), {
      command: "reason",
      args: ["acp"],
      cwd: "/work",
    });
    const custom = buildReasonAcpSpawnInput(
      decodeSettings({ binaryPath: "/opt/reason/bin/reason" }),
      "/work",
      { REASON_API_KEY: "rk_test" },
    );
    assert.equal(custom.command, "/opt/reason/bin/reason");
    assert.deepEqual(custom.args, ["acp"]);
    assert.deepEqual(custom.env, { REASON_API_KEY: "rk_test" });
  });

  // Output layout recorded from `reason whoami` on Reason CLI 0.2.681.
  it("reads the sign-in state from reason whoami", () => {
    const stdout = "dev@example.com\nOrganization: Example\nSaved workspaces:\n  example [selected]\n";
    assert.deepEqual(reasonAuthFromWhoami({ code: 0, stdout }, {}), {
      status: "authenticated",
      label: "Reason account",
      email: "dev@example.com",
    });
    assert.deepEqual(reasonAuthFromWhoami({ code: 1, stdout: "Not signed in\n" }, {}), {
      status: "unauthenticated",
    });
    assert.deepEqual(reasonAuthFromWhoami({ code: 1, stdout: "" }, { REASON_API_KEY: "rk" }), {
      status: "authenticated",
      type: "api_key",
      label: "Reason API key",
    });
    assert.deepEqual(reasonAuthFromWhoami(undefined, {}), { status: "unknown" });
  });
});
