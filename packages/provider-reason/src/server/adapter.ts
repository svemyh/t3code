import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { readCustomModelEntries } from "@t3tools/shared/model";
import { ReasonSettings } from "../settings.ts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeReasonAcpRuntime, REASON_STOPPED_NOTICE, reasonInBandFailure } from "./acpSupport.ts";

const REASON_PROVIDER = ProviderDriverKind.make("reason");
const DEFAULT_REASON_SETTINGS = Schema.decodeSync(ReasonSettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/**
 * Reason runs its own tools in its own sandbox and never asks the client for
 * permission, files, terminals, or answers ("Reason uses its own tools, not the
 * editor's"), so approvals and questions are off and policy is Reason's own.
 */
const ReasonProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
  },
  approvals: {
    ...AcpProviderCapabilitiesV2.approvals,
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
  },
  planning: {
    ...AcpProviderCapabilitiesV2.planning,
    // A Reason question ends the turn as text; the next prompt answers it.
    supportsStructuredQuestions: false,
  },
  runtimePolicy: { enforcement: "native" },
} satisfies OrchestrationV2ProviderCapabilities;

export interface ReasonAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: ReasonSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  /** Replaces the `reason acp` launch (replay tests). */
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

function reasonPromptFailure(cause: unknown) {
  return makeProviderFailure({
    cause,
    ...(isAcpRequestError(cause) ? { message: cause.errorMessage, code: String(cause.code) } : {}),
    class: "provider_error",
  });
}

/**
 * Reason reports a failed request as reply text and `end_turn`. This hides
 * that reply, and Reason's own "Stopped" notice, and keeps the failure so
 * `watchPromptOutcome` can fail the turn with it.
 */
function makeReasonInBandFailures() {
  const failures = new Map<string, OrchestrationV2ProviderFailure>();
  return {
    ignoreSessionUpdate: (notification: EffectAcpSchema.SessionNotification) => {
      const { update } = notification;
      if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
        return false;
      }
      if (update.content.text.trim() === REASON_STOPPED_NOTICE) return true;
      const failure = reasonInBandFailure(update.content.text);
      if (failure === undefined) return false;
      failures.set(notification.sessionId, failure);
      return true;
    },
    watchPromptOutcome: (sessionId: string) =>
      Effect.sync(() => {
        failures.delete(sessionId);
        return (_result: EffectAcpSchema.PromptResponse) =>
          Effect.sync(() => {
            const failure = failures.get(sessionId);
            failures.delete(sessionId);
            return failure;
          });
      }),
  };
}

function makeReasonAcpAdapterFlavor(options: ReasonAdapterV2Options): AcpAdapterV2Flavor {
  const customModels = readCustomModelEntries(options.settings.customModels).map(
    (entry) => entry.slug,
  );
  const makeRuntime =
    options.makeRuntime ??
    ((input: AcpAdapterV2RuntimeInput) => {
      const { runtimePolicy: _runtimePolicy, processEnvironment, ...runtimeInput } = input;
      return makeReasonAcpRuntime({
        ...runtimeInput,
        customModels,
        settings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
      });
    });
  const inBandFailures = makeReasonInBandFailures();
  return {
    driver: REASON_PROVIDER,
    runtimeHarness: "Reason",
    capabilities: ReasonProviderCapabilitiesV2,
    customModels,
    makeRuntime,
    promptFailure: reasonPromptFailure,
    ignoreSessionUpdate: inBandFailures.ignoreSessionUpdate,
    watchPromptOutcome: inBandFailures.watchPromptOutcome,
    // A `/compact` prompt is ordinary model input to Reason.
    supportsCompaction: false,
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

const makeReasonAdapterV2 = Effect.fn("makeReasonAdapterV2")(function* (
  options: ReasonAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeReasonAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
});

export type ReasonAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const ReasonAdapterV2Driver: ProviderAdapterDriver<
  ReasonSettings,
  ReasonAdapterV2DriverEnv
> = {
  driverKind: REASON_PROVIDER,
  configSchema: ReasonSettings,
  defaultConfig: (): ReasonSettings => DEFAULT_REASON_SETTINGS,
  create: Effect.fn("ReasonAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<ReasonSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeReasonAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: REASON_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: REASON_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Reason ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
