import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { ReasonSettings } from "../settings.ts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import { REASON_EFFORT_CONFIG_ID } from "./acpSupport.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";

const REASON_DRIVER_KIND = ProviderDriverKind.make("reason");
const REASON_PRESENTATION = {
  displayName: "Reason",
  showInteractionModeToggle: false,
  // Reason runs its own tools and never asks for approval, so it offers no supervised mode.
  supportedRuntimeModes: ["full-access"],
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
/** Reason's own "Auto" model: the Workspace's default. A valid ACP value, not a T3 sentinel. */
const REASON_DEFAULT_MODEL = "default";
const REASON_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: REASON_DEFAULT_MODEL,
    name: "Auto",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];
const REASON_API_KEY_ENV = "REASON_API_KEY";
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

const encoder = new TextEncoder();

/** Runs `reason`; `input` goes to stdin, for `reason call OPERATION --input-file -`. */
const runReasonCli = Effect.fn("ReasonProvider.runReasonCli")(function* (
  settings: ReasonSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  input?: string,
) {
  const command = settings.binaryPath || "reason";
  const fullArgs = settings.workspace ? ["--workspace", settings.workspace, ...args] : args;
  const spawnCommand = yield* resolveSpawnCommand(command, fullArgs, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
      ...(input === undefined ? {} : { stdin: Stream.make(encoder.encode(input)) }),
    }),
  );
});

/** `reason call` prints one versioned JSON result, `ok: false` with an error code on failure. */
const ReasonCallError = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.Struct({ code: Schema.String }),
});
const decodeReasonCallError = Schema.decodeUnknownOption(Schema.fromJsonString(ReasonCallError));

const ReasonSelf = Schema.Struct({
  ok: Schema.Literal(true),
  data: Schema.Struct({
    principal_type: Schema.optional(Schema.String),
    email: Schema.optional(Schema.NullOr(Schema.String)),
    organization_name: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
const decodeReasonSelf = Schema.decodeUnknownOption(Schema.fromJsonString(ReasonSelf));

const SIGNED_OUT_CODES = new Set(["authentication_required", "missing_bearer", "invalid_api_key"]);

/** Reads `reason call getSelf` into the account T3 shows. */
export function reasonAuthFromSelf(
  output: { readonly code: number; readonly stdout: string } | undefined,
  environment: NodeJS.ProcessEnv,
): ServerProviderAuth {
  if (output === undefined) return { status: "unknown" };
  const stdout = output.stdout.trim();
  const self = Option.getOrUndefined(decodeReasonSelf(stdout));
  if (self === undefined) {
    const error = Option.getOrUndefined(decodeReasonCallError(stdout));
    return error !== undefined && SIGNED_OUT_CODES.has(error.error.code)
      ? { status: "unauthenticated" }
      : { status: "unknown" };
  }
  const organization = self.data.organization_name?.trim();
  return {
    status: "authenticated",
    ...(environment[REASON_API_KEY_ENV]?.trim() || self.data.principal_type === "api_key"
      ? { type: "api_key" }
      : {}),
    label: organization ? `Reason · ${organization}` : "Reason account",
    ...(self.data.email ? { email: self.data.email } : {}),
  };
}

const ReasonModelList = Schema.Struct({
  ok: Schema.Literal(true),
  data: Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.optional(Schema.NullOr(Schema.String)),
        detail: Schema.optional(Schema.NullOr(Schema.String)),
        reasoning_efforts: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
        hidden: Schema.optional(Schema.NullOr(Schema.Boolean)),
        available: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  }),
});
const decodeReasonModelList = Schema.decodeUnknownOption(Schema.fromJsonString(ReasonModelList));

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/**
 * Reason's `default` effort leads, since its model list names no default
 * level. One level is nothing to choose between.
 */
function reasonModelCapabilities(efforts: ReadonlyArray<string> | null | undefined) {
  if (efforts == null || efforts.length < 2) return EMPTY_CAPABILITIES;
  return createModelCapabilities({
    optionDescriptors: [
      {
        ...buildSelectOptionDescriptor({
          id: REASON_EFFORT_CONFIG_ID,
          label: "Reasoning",
          options: [
            { value: "default", label: "Default", isDefault: true },
            ...efforts.map((level) => ({ value: level, label: EFFORT_LABELS[level] ?? level })),
          ],
        }),
        role: "reasoning" as const,
      },
    ],
  });
}

/**
 * Reads `reason call listAgentModels`, the same models `reason acp` offers in
 * its `model` option (0.2.678), without opening a Reason Session. Hidden and
 * unavailable models are left out, as Reason's own picker does.
 */
export function reasonModelsFromList(
  output: { readonly code: number; readonly stdout: string } | undefined,
): ReadonlyArray<ServerProviderModel> | undefined {
  if (output === undefined || output.code !== 0) return undefined;
  const list = Option.getOrUndefined(decodeReasonModelList(output.stdout.trim()));
  if (list === undefined) return undefined;
  const models = list.data.models.flatMap((model): ReadonlyArray<ServerProviderModel> => {
    const slug = model.id.trim();
    if (model.hidden === true || model.available === false || slug.length === 0) return [];
    if (slug === REASON_DEFAULT_MODEL) return [];
    const subProvider = model.detail?.trim();
    return [
      {
        slug,
        name: model.label?.trim() || slug,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        capabilities: reasonModelCapabilities(model.reasoning_efforts),
      },
    ];
  });
  return [...REASON_BUILT_IN_MODELS, ...models];
}

export const checkReasonProviderStatus = Effect.fn("checkReasonProviderStatus")(function* (
  settings: ReasonSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
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
        ? "Reason CLI (`reason`) is not installed or not on PATH. Install it with `npm install -g @reason-machines/cli`."
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

  const callReason = (operation: string) =>
    runReasonCli(settings, ["call", operation, "--input-file", "-"], environment, "{}").pipe(
      Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
  const [self, listed] = yield* Effect.all([callReason("getSelf"), callReason("listAgentModels")], {
    concurrency: "unbounded",
  });
  const auth = reasonAuthFromSelf(self, environment);
  if (auth.status === "unauthenticated") {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth,
      message:
        "Reason CLI is installed but not signed in. Run `reason login` or set REASON_API_KEY.",
    });
  }
  const missingMachine = settings.runsOn === "machine" && !settings.machine;
  return snapshot(
    settings,
    checkedAt,
    {
      installed: true,
      version,
      status: auth.status === "authenticated" && !missingMachine ? "ready" : "warning",
      auth,
      ...(missingMachine
        ? { message: "Runs on is A shared machine, but no machine is named; threads run here." }
        : auth.status === "authenticated"
          ? {}
          : { message: "Could not confirm the Reason sign-in. Run `reason whoami` to check." }),
    },
    reasonModelsFromList(listed),
  );
});
