import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { ReasonSettings } from "../settings.ts";

/** Reason's `model` session option, advertised in the `session/new` result. */
export const REASON_MODEL_CONFIG_ID = "model";

type ReasonAcpRuntimeSettings = Pick<ReasonSettings, "binaryPath" | "target">;

/**
 * `reason acp` speaks ACP on stdio. Each thread is a Reason Session that runs
 * on this computer in the thread's folder, or on a Reason cloud computer with
 * `--cloud`. Tool approvals stay with Reason, so `-y` is not passed.
 */
export function buildReasonAcpSpawnInput(
  settings: ReasonAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "reason",
    args: settings?.target === "cloud" ? ["acp", "--cloud"] : ["acp"],
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
  };
}

export interface ReasonAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly settings: ReasonAcpRuntimeSettings | null | undefined;
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
