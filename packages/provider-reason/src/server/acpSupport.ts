import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import type { ReasonSettings } from "../settings.ts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

/** Reason's reasoning effort session option (`category: "thought_level"`). */
export const REASON_EFFORT_CONFIG_ID = "reasoning_effort";

type ReasonLaunchSettings = Pick<ReasonSettings, "binaryPath" | "runsOn" | "machine" | "workspace">;

/**
 * `reason [--workspace W] acp -y [--cloud | --on NAME]`. `-y` accepts Reason's
 * defaults, since nobody can answer its prompts on stdio. `--workspace` belongs
 * before `acp`. A shared machine without a name runs on this computer; the
 * status check reports the missing name.
 */
export function buildReasonAcpArgs(settings: ReasonLaunchSettings): ReadonlyArray<string> {
  return [
    ...(settings.workspace ? ["--workspace", settings.workspace] : []),
    "acp",
    "-y",
    ...(settings.runsOn === "cloud"
      ? ["--cloud"]
      : settings.runsOn === "machine" && settings.machine
        ? ["--on", settings.machine]
        : []),
  ];
}

function buildReasonAcpSpawnInput(
  settings: ReasonLaunchSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings.binaryPath || "reason",
    args: [...buildReasonAcpArgs(settings)],
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
  };
}

/**
 * Reason reports a failed request as the turn's only reply and ends it with
 * `end_turn` (0.2.678: "Reason request failed (404 device_not_found). Run from
 * a folder in your home folder, or add --cloud."). This reads that reply into
 * a failure, classified by its HTTP status.
 */
const IN_BAND_FAILURE = /^Reason request failed \((\d{3})(?: ([a-z0-9_]+))?\)/;

export function reasonInBandFailure(text: string): OrchestrationV2ProviderFailure | undefined {
  const match = IN_BAND_FAILURE.exec(text.trim());
  if (match === null) return undefined;
  const status = Number(match[1]);
  return makeProviderFailure({
    message: text.trim(),
    code: match[2] ?? String(status),
    class:
      status === 402 || status === 429
        ? "usage_limit"
        : status === 401 || status === 403
          ? "permission_error"
          : status >= 500
            ? "transport_error"
            : "provider_error",
    retryable: status === 429 || status >= 500,
  });
}

/** Reason's reply to `session/cancel`; T3 shows its own stopped state instead. */
export const REASON_STOPPED_NOTICE = "Stopped. Send a message to continue.";

export interface ReasonAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly settings: ReasonLaunchSettings;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeReasonAcpRuntime = Effect.fn("ReasonAcpSupport.makeReasonAcpRuntime")(function* (
  input: ReasonAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const { settings, environment, ...runtimeOptions } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeOptions,
      spawn: buildReasonAcpSpawnInput(settings, input.cwd, environment),
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});
