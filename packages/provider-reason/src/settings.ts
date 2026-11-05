import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Where `reason acp` runs a Session: this computer (default) or Reason's cloud. */
export const ReasonExecutionTarget = Schema.Literals(["local", "cloud"]);
export type ReasonExecutionTarget = typeof ReasonExecutionTarget.Type;

export const ReasonSettings = makeProviderSettingsSchema(
  {
    // On by default: this fork runs its threads on the Reason runtime.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("reason").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Reason CLI binary.",
        providerSettingsForm: { placeholder: "reason", clearWhenEmpty: "omit" },
      }),
    ),
    target: ReasonExecutionTarget.pipe(
      Schema.withDecodingDefault(Effect.succeed("local")),
      Schema.annotateKey({
        title: "Run on",
        description: "Run Reason Sessions on this computer or on a Reason cloud computer.",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "local", label: "This computer" },
            { value: "cloud", label: "Reason cloud" },
          ],
        },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "target"],
  },
);
export type ReasonSettings = typeof ReasonSettings.Type;
