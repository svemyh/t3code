import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ReasonSettings } from "../settings.ts";
import { buildReasonAcpSpawnInput } from "./acpSupport.ts";
import { reasonAuthFromWhoami, reasonModelsFromSession } from "./status.ts";

const decodeSettings = Schema.decodeUnknownSync(ReasonSettings);

describe("ReasonDriver", () => {
  it("is enabled by default and launches `reason acp` locally or in the cloud", () => {
    assert.equal(decodeSettings({}).enabled, true);
    assert.deepEqual(buildReasonAcpSpawnInput(decodeSettings({}), "/work"), {
      command: "reason",
      args: ["acp"],
      cwd: "/work",
    });
    const cloud = buildReasonAcpSpawnInput(
      decodeSettings({ binaryPath: "/opt/reason", target: "cloud" }),
      "/work",
      { REASON_API_KEY: "test" },
    );
    assert.equal(cloud.command, "/opt/reason");
    assert.deepEqual(cloud.args, ["acp", "--cloud"]);
    assert.deepEqual(cloud.env, { REASON_API_KEY: "test" });
  });

  // Output recorded from `reason whoami` on Reason CLI 0.2.678.
  it("reads the sign-in state from reason whoami", () => {
    assert.deepEqual(
      reasonAuthFromWhoami({ code: 0, stdout: "dev@example.com\nOrganization: Acme\n" }, {}),
      { status: "authenticated", label: "Reason account", email: "dev@example.com" },
    );
    assert.deepEqual(reasonAuthFromWhoami({ code: 1, stdout: "" }, {}), {
      status: "unauthenticated",
    });
    assert.deepEqual(reasonAuthFromWhoami(undefined, {}), { status: "unknown" });
  });

  // Shape recorded from `reason acp` session/new on 0.2.678.
  it("lists models from the session/new model option", () => {
    const models = reasonModelsFromSession({
      sessionId: "s",
      configOptions: [
        {
          id: "model",
          type: "select",
          currentValue: "default",
          options: [
            { value: "default", name: "Auto", description: "Your Workspace's default" },
            { value: "openai/gpt-6.1-sol", name: "Reason" },
          ],
        },
      ],
    });
    assert.deepEqual(
      models?.map((model) => [model.slug, model.isDefault ?? false]),
      [
        ["default", true],
        ["openai/gpt-6.1-sol", false],
      ],
    );
    assert.equal(reasonModelsFromSession({ configOptions: [] }), undefined);
  });
});
