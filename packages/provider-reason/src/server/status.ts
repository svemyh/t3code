import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { ReasonSettings } from "../settings.ts";
import { makeReasonAcpRuntime, REASON_MODEL_CONFIG_ID } from "./acpSupport.ts";

const REASON_DRIVER_KIND = ProviderDriverKind.make("reason");
const REASON_PRESENTATION = {
  displayName: "Reason",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["full-access"],
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
export const REASON_DEFAULT_MODEL_SLUG = "default";
const REASON_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: REASON_DEFAULT_MODEL_SLUG,
    name: "Auto",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];
const VERSION_PROBE_TIMEOUT_MS = 10_000;

const snapshot = (
  settings: ReasonSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  listed: ReadonlyArray<ServerProviderModel> = REASON_BUILT_IN_MODELS,
) =>
  buildServerProvider({
    driver: REASON_DRIVER_KIND,
    presentation: REASON_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: providerModelsFromSettings(listed, settings.customModels, EMPTY_CAPABILITIES),
    probe,
  });

export const buildInitialReasonProviderSnapshot = Effect.fn(
  "ReasonProvider.buildInitialReasonProviderSnapshot",
)(function* (settings: ReasonSettings): Effect.fn.Return<ServerProviderDraft> {
  const now = yield* DateTime.now;
  return snapshot(settings, DateTime.formatIso(now), {
    installed: settings.enabled,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: settings.enabled
      ? "Checking Reason CLI availability..."
      : "Reason is disabled in T3 Code settings.",
  });
});

const runReasonCli = Effect.fn("ReasonProvider.runReasonCli")(function* (
  settings: ReasonSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "reason";
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

/**
 * Reads `reason whoami`: the first line is the signed-in email, followed by the
 * organization. A non-zero exit means signed out.
 */
export function reasonAuthFromWhoami(
  output: { readonly code: number; readonly stdout: string } | undefined,
  environment: NodeJS.ProcessEnv,
): ServerProviderAuth {
  if (output === undefined) return { status: "unknown" };
  if (output.code !== 0) return { status: "unauthenticated" };
  const email = (output.stdout.trimStart().split("\n", 1)[0] ?? "").trim();
  if (environment.REASON_API_KEY?.trim()) {
    return { status: "authenticated", type: "api_key", label: "Reason API key" };
  }
  return {
    status: "authenticated",
    label: "Reason account",
    ...(email.includes("@") ? { email } : {}),
  };
}

const ReasonModelOption = Schema.Struct({
  configOptions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        type: Schema.String,
        currentValue: Schema.optional(Schema.Unknown),
        options: Schema.optional(
          Schema.Array(
            Schema.Struct({
              value: Schema.String,
              name: Schema.String,
              description: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
});
const decodeReasonModelOption = Schema.decodeUnknownOption(ReasonModelOption);

/** The Workspace's models, from the `model` select of a `session/new` result. */
export function reasonModelsFromSession(
  result: unknown,
): ReadonlyArray<ServerProviderModel> | undefined {
  const decoded = Option.getOrUndefined(decodeReasonModelOption(result));
  const model = decoded?.configOptions?.find(
    (option) => option.id === REASON_MODEL_CONFIG_ID && option.type === "select",
  );
  const choices = model?.options ?? [];
  if (choices.length === 0) return undefined;
  const current = typeof model?.currentValue === "string" ? model.currentValue : undefined;
  return choices.map((choice) => ({
    slug: choice.value,
    name: choice.description ? `${choice.name} (${choice.description})` : choice.name,
    isCustom: false,
    ...(choice.value === current ? { isDefault: true } : {}),
    capabilities: EMPTY_CAPABILITIES,
  }));
}

/**
 * Lists the Workspace's models by opening one ACP session. Reason has no
 * model-list command, and `session/new` advertises them.
 */
const probeReasonModels = Effect.fn("ReasonProvider.probeReasonModels")(function* (
  settings: ReasonSettings,
  environment: NodeJS.ProcessEnv,
) {
  const cwd = yield* HostProcess.WorkingDirectory;
  const runtime = yield* makeReasonAcpRuntime({
    settings,
    environment,
    cwd,
    clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
  });
  yield* runtime.initialize();
  return reasonModelsFromSession(yield* runtime.request("session/new", { cwd, mcpServers: [] }));
}, Effect.scoped);

export const checkReasonProviderStatus = Effect.fn("checkReasonProviderStatus")(function* (
  settings: ReasonSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Reason is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runReasonCli(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const missing = Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
    return snapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Reason CLI (`reason`) is not installed or not on PATH. See https://docs.reasonmachines.com/docs/cli."
        : "Failed to run `reason --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);

  const whoamiResult = yield* runReasonCli(settings, ["whoami"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const auth = reasonAuthFromWhoami(
    Result.isSuccess(whoamiResult) ? Option.getOrUndefined(whoamiResult.success) : undefined,
    environment,
  );
  if (auth.status === "unauthenticated") {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth,
      message: "Reason CLI is installed but not signed in. Run `reason login`.",
    });
  }
  const listed =
    auth.status === "authenticated"
      ? yield* probeReasonModels(settings, environment).pipe(
          Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        )
      : undefined;
  return snapshot(
    settings,
    checkedAt,
    {
      installed: true,
      version,
      status: auth.status === "authenticated" ? "ready" : "warning",
      auth,
      ...(auth.status === "authenticated"
        ? {}
        : { message: "Could not confirm the Reason sign-in. Run `reason whoami` to check." }),
    },
    listed,
  );
});
