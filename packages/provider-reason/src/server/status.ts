import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { ReasonSettings } from "../settings.ts";
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
  REASON_AGENT_CONFIG_ID,
  REASON_SUPPORTED_RUNTIME_MODES,
  makeReasonAcpRuntime,
} from "./acpSupport.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  buildSelectOptionDescriptor,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";

const REASON_DRIVER_KIND = ProviderDriverKind.make("reason");
const REASON_PRESENTATION = {
  displayName: "Reason",
  showInteractionModeToggle: false,
  supportedRuntimeModes: REASON_SUPPORTED_RUNTIME_MODES,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const REASON_DEFAULT_MODEL_SLUG = "default";
const REASON_FALLBACK_DEFAULT_MODEL = "auto";
const REASON_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: REASON_DEFAULT_MODEL_SLUG,
    name: "Reason default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];
const REASON_API_KEY_ENV = "REASON_API_KEY";
const VERSION_PROBE_TIMEOUT_MS = 10_000;

/**
 * The agent picker is not a model trait, but the composer reads options per
 * model, so every model, custom ones included, carries it.
 */
const reasonModels = (
  settings: ReasonSettings,
  listed: ReadonlyArray<ServerProviderModel> = REASON_BUILT_IN_MODELS,
  agents?: ProviderOptionDescriptor,
) =>
  providerModelsFromSettings(listed, settings.customModels, EMPTY_CAPABILITIES).map((model) => {
    const descriptors = model.capabilities?.optionDescriptors ?? [];
    return agents === undefined || descriptors.some((descriptor) => descriptor.id === agents.id)
      ? model
      : {
          ...model,
          capabilities: createModelCapabilities({ optionDescriptors: [...descriptors, agents] }),
        };
  });

const snapshot = (
  settings: ReasonSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  listed?: ReadonlyArray<ServerProviderModel>,
  agents?: ProviderOptionDescriptor,
) =>
  buildServerProvider({
    // Gives the snapshot its version advisory; Reason runs no enrichment pass.
    driver: REASON_DRIVER_KIND,
    presentation: REASON_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: reasonModels(settings, listed, agents),
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
 * Reads `reason whoami`: its first line is the signed-in account's email.
 * A failed run or no email means signed out.
 */
export function reasonAuthFromWhoami(
  output: { readonly code: number; readonly stdout: string } | undefined,
  environment: NodeJS.ProcessEnv,
): ServerProviderAuth {
  if (output === undefined) return { status: "unknown" };
  if (environment[REASON_API_KEY_ENV]?.trim()) {
    return { status: "authenticated", type: "api_key", label: "Reason API key" };
  }
  const email = output.stdout.trimStart().split("\n", 1)[0]?.trim() ?? "";
  if (output.code !== 0 || !email.includes("@")) return { status: "unauthenticated" };
  return { status: "authenticated", label: "Reason account", email };
}

/**
 * Reason's own id for "Reason default": the alias the model list gave it, else
 * `auto`, Reason's documented default.
 */
export function reasonDefaultModelId(models: ReadonlyArray<ServerProviderModel>): string {
  return (
    models.find((model) => model.slug === REASON_DEFAULT_MODEL_SLUG)?.aliases?.[0] ??
    REASON_FALLBACK_DEFAULT_MODEL
  );
}

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
        ? "Reason CLI (`reason`) is not installed or not on PATH."
        : "Failed to run `reason --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Reason CLI is installed but failed to run.",
    });
  }

  const whoamiResult = yield* runReasonCli(
    settings,
    ["whoami"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
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
      message: "Reason CLI is installed but not signed in. Run `reason login` (or set REASON_API_KEY).",
    });
  }
  // Reason's models and agents are chosen per Session on the Reason side, so
  // only the built-in default model is listed; custom models still apply.
  const listed = undefined;
  const agents = undefined;
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
    agents,
  );
});
