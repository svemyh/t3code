import {
  CustomModelSetting,
  TrimmedString,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Where Reason runs the agent's commands: `reason acp`, `--cloud`, or `--on NAME`. */
export const ReasonRunsOn = Schema.Literals(["local", "cloud", "machine"]);
export type ReasonRunsOn = typeof ReasonRunsOn.Type;

export const ReasonSettings = makeProviderSettingsSchema(
  {
    // On by default: this fork runs threads on Reason.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    runsOn: ReasonRunsOn.pipe(
      Schema.withDecodingDefault(Effect.succeed("local")),
      Schema.annotateKey({
        title: "Runs on",
        description:
          "Where the agent's commands run. The agent itself always runs in Reason's cloud.",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "local", label: "This computer" },
            { value: "cloud", label: "Reason cloud" },
            { value: "machine", label: "A shared machine" },
          ],
        },
      }),
    ),
    machine: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Machine",
        description: "Machine name for A shared machine, from `reason machines`.",
        providerSettingsForm: { placeholder: "build", clearWhenEmpty: "omit" },
      }),
    ),
    workspace: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Workspace",
        description: "Reason Workspace slug or ID. Empty uses the one `reason whoami` selects.",
        providerSettingsForm: { placeholder: "Signed-in Workspace", clearWhenEmpty: "omit" },
      }),
    ),
    binaryPath: makeBinaryPathSetting("reason").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Reason CLI binary.",
        providerSettingsForm: { placeholder: "reason", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["runsOn", "machine", "workspace", "binaryPath"],
  },
);
export type ReasonSettings = typeof ReasonSettings.Type;
