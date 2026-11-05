import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  type ModelSelection,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import { ReasonSettings } from "../settings.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
  type AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
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
import {
  REASON_AGENT_CONFIG_ID,
  REASON_AUTOPILOT_CONFIG_ID,
  REASON_EFFORT_CONFIG_ID,
  REASON_MODEL_CONFIG_ID,
  reasonApprovalOptions,
  reasonAutopilotValue,
  reasonPermissionDisposition,
  makeReasonAcpRuntime,
} from "./acpSupport.ts";

export const REASON_PROVIDER = ProviderDriverKind.make("reason");
/** T3's slug for "Reason default", and Reason's documented default model id. */
const REASON_DEFAULT_MODEL = "default";
const REASON_COMPACT_METHOD = "_reason/session/compact";
const REASON_STEER_METHOD = "_session/steer";
const REASON_FALLBACK_DEFAULT_MODEL = "auto";
const DEFAULT_REASON_SETTINGS = Schema.decodeSync(ReasonSettings)({});

const ReasonProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
  },
  // Reason 2.27 and later fork at a turn's prompt (`_meta.reason.messageId`); see reasonForkFromTurn.
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canForkThread: true,
    canForkFromTurn: true,
  },
  // `_session/steer` waits for the running tool, then Reason reads the message at its next step.
  turns: {
    ...AcpProviderCapabilitiesV2.turns,
    supportsActiveSteering: true,
    activeSteeringInterruptsTools: false,
    // `_session/steer` takes a string, so a message with images restarts the turn.
    activeSteeringAcceptsAttachments: false,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    emitsSubagentLifecycle: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

const ReasonCompactResult = Schema.Struct({ success: Schema.Boolean });
const decodeReasonCompactResult = Schema.decodeUnknownOption(ReasonCompactResult);

/** Reason answers a `/compact` prompt as chat, so T3 compacts with Reason's own request. */
const compactReasonSession = (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  sessionId: string,
) =>
  runtime.request(REASON_COMPACT_METHOD, { sessionId }).pipe(
    Effect.flatMap((result) =>
      Option.exists(decodeReasonCompactResult(result), (decoded) => decoded.success)
        ? Effect.void
        : Effect.fail(
            new EffectAcpErrors.AcpRequestError({
              code: -32603,
              errorMessage: "Reason could not compact the conversation.",
              method: REASON_COMPACT_METHOD,
              data: result,
            }),
          ),
    ),
  );

const ReasonSteerResult = Schema.Struct({ queued: Schema.Literal(true), messageId: Schema.String });
const decodeReasonSteerResult = Schema.decodeUnknownOption(ReasonSteerResult);
const ReasonSteeringInjected = Schema.Struct({
  reason: Schema.Struct({ kind: Schema.Literal("steering_injected"), messageId: Schema.String }),
});
const decodeReasonSteeringInjected = Schema.decodeUnknownOption(ReasonSteeringInjected);

/** Reason queues a steer, then reports `steering_injected` with its id once the model reads it. */
const reasonSteering = {
  send: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    sessionId: string,
    text: string,
  ) =>
    runtime.request(REASON_STEER_METHOD, { sessionId, message: text }).pipe(
      Effect.flatMap((result) =>
        Option.match(decodeReasonSteerResult(result), {
          onSome: (decoded) => Effect.succeed(decoded.messageId),
          onNone: () =>
            Effect.fail(
              new EffectAcpErrors.AcpRequestError({
                code: -32603,
                errorMessage: "Reason did not queue the steering message.",
                method: REASON_STEER_METHOD,
                data: result,
              }),
            ),
        }),
      ),
    ),
  injectedSteerId: (notification: EffectAcpSchema.SessionNotification) =>
    notification.update.sessionUpdate === "session_info_update"
      ? Option.getOrUndefined(decodeReasonSteeringInjected(notification.update._meta))?.reason.messageId
      : undefined,
};

const decodeReasonForkCapability = Schema.decodeUnknownOption(
  Schema.Struct({ reason: Schema.Struct({ messageId: Schema.Literal(true) }) }),
);
const decodeReasonUserMessageId = Schema.decodeUnknownOption(
  Schema.Struct({
    reason: Schema.Struct({
      kind: Schema.Literal("user_message_id_assigned"),
      userMessageId: Schema.String,
    }),
  }),
);

/**
 * Reason assigns each prompt a `userMessageId`, and `session/fork` with that id keeps the
 * session up to and including the reply to that prompt.
 */
const reasonForkFromTurn = {
  supported: (
    initializeResult: AcpSessionRuntime.AcpSessionRuntimeStartResult["initializeResult"],
  ) =>
    Option.isSome(
      decodeReasonForkCapability(
        initializeResult.agentCapabilities?.sessionCapabilities?.fork?._meta,
      ),
    ),
  nativeTurnId: (notification: EffectAcpSchema.SessionNotification) =>
    notification.update.sessionUpdate === "session_info_update"
      ? Option.getOrUndefined(decodeReasonUserMessageId(notification.update._meta))?.reason
          .userMessageId
      : undefined,
  forkMeta: (messageId: string) => ({ reason: { messageId } }),
};

export interface ReasonAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: ReasonSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  /**
   * Reason's id for "Reason default" (the provider snapshot's `--list-models`
   * default). Absent, it is `auto`.
   */
  readonly defaultModel?: Effect.Effect<string>;
  /** Replaces the `reason` launch (replay tests). Reason's session setup still applies. */
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
}

/** Reason's `model` option once it advertises one. */
const findReasonModelOption = (configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) =>
  configOptions.find((option) => option.id === REASON_MODEL_CONFIG_ID || option.category === "model");

/**
 * Reason selects models only through its `model` config option; "default" is
 * Reason's own default. The write goes to `model` even before Reason advertises it,
 * and for unlisted ids: Reason fails the next prompt on a model it can't use.
 */
const applyReasonModel = Effect.fn("ReasonAdapterV2.applyReasonModel")(function* (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  modelSelection: ModelSelection,
  defaultModel: Effect.Effect<string>,
  agentSwitched: boolean,
) {
  const modelOption = findReasonModelOption(yield* runtime.getConfigOptions);
  const current = modelOption?.type === "select" ? modelOption.currentValue : undefined;
  const selected = modelSelection.model.trim();
  const isDefault = selected.length === 0 || selected === REASON_DEFAULT_MODEL;
  // Before Reason advertises `model` the session is new, so it already runs
  // Reason's default, unless an agent switch just moved it to the agent's model.
  if (isDefault && modelOption?.type !== "select" && !agentSwitched) {
    return current;
  }
  const requested = isDefault ? yield* defaultModel : selected;
  if (requested === current) {
    return current;
  }
  yield* runtime.setConfigOption(modelOption?.id ?? REASON_MODEL_CONFIG_ID, requested, {
    allowUnlistedValue: true,
  });
  return requested;
});

/**
 * Bound on waiting for Reason to advertise the model T3 just wrote. Reason 2.27.0
 * sent it 40-90 ms after the write's result.
 */
const REASON_MODEL_ADVERT_BOUND = "2 seconds";

/**
 * Writes the thread's effort to Reason's `effortLevel` once Reason advertises the
 * written model, since Reason ignores the option before then and resets it on a
 * model change. Levels the model doesn't offer are not sent. A rejected write
 * or no advert within the bound keeps Reason's level rather than failing the turn.
 */
const applyReasonEffort = Effect.fn("ReasonAdapterV2.applyReasonEffort")(function* (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  modelSelection: ModelSelection,
  appliedModel: string | undefined,
) {
  const requested = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
  if (requested === undefined) return;
  const advertised = yield* runtime.configOptionChanges.pipe(
    Stream.filter((configOptions) => {
      const modelOption = findReasonModelOption(configOptions);
      return (
        appliedModel === undefined ||
        (modelOption?.type === "select" && modelOption.currentValue === appliedModel)
      );
    }),
    Stream.runHead,
    Effect.timeoutOption(REASON_MODEL_ADVERT_BOUND),
    Effect.map(Option.flatten),
  );
  if (Option.isNone(advertised)) {
    return yield* Effect.logWarning("Reason did not advertise the model's reasoning effort", {
      waitedForWrittenModel: appliedModel !== undefined,
    });
  }
  const effortOption = advertised.value.find((option) => option.id === REASON_EFFORT_CONFIG_ID);
  if (effortOption?.type !== "select" || !selectValues(effortOption).includes(requested)) {
    return;
  }
  yield* runtime.setConfigOption(REASON_EFFORT_CONFIG_ID, requested).pipe(
    Effect.catchTags({
      // `requested` is one of the levels Reason just advertised, so it is safe to log.
      AcpRequestError: (error) =>
        Effect.logWarning("Reason rejected the reasoning effort", {
          value: requested,
          code: error.code,
        }),
    }),
  );
});

/**
 * Selects the thread's Reason agent and reports whether a switch went out. It runs
 * before the model write, because switching applies the agent's own model. An
 * agent the session doesn't list is skipped: Reason would accept it and not switch.
 */
const applyReasonAgent = Effect.fn("ReasonAdapterV2.applyReasonAgent")(function* (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  modelSelection: ModelSelection,
) {
  const requested = getModelSelectionStringOptionValue(modelSelection, REASON_AGENT_CONFIG_ID);
  if (requested === undefined) return false;
  const agentOption = (yield* runtime.getConfigOptions).find(
    (option) => option.id === REASON_AGENT_CONFIG_ID,
  );
  if (agentOption?.type !== "select" || agentOption.currentValue === requested) return false;
  if (!selectValues(agentOption).includes(requested)) {
    yield* Effect.logWarning("Reason does not list the thread's agent", {
      listedAgents: selectValues(agentOption).length,
    });
    return false;
  }
  yield* runtime.setConfigOption(REASON_AGENT_CONFIG_ID, requested);
  return true;
});

const applyReasonModelSelection =
  (defaultModel: Effect.Effect<string>): NonNullable<AcpAdapterV2Flavor["applyModelSelection"]> =>
  ({ runtime, modelSelection }) =>
    applyReasonAgent(runtime, modelSelection).pipe(
      Effect.flatMap((agentSwitched) =>
        applyReasonModel(runtime, modelSelection, defaultModel, agentSwitched),
      ),
      Effect.tap((appliedModel) => applyReasonEffort(runtime, modelSelection, appliedModel)),
    );

function selectValues(
  option: Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }>,
): ReadonlyArray<string> {
  return option.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
  );
}

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/**
 * Evidence that Reason started the current prompt, so Stop's `session/cancel` is
 * honored: a `turn_start` info update or output only a running prompt produces.
 * Reason doesn't promise `turn_start`, so Stop gives up after REASON_CANCEL_HOLD_BOUND.
 */
function isReasonPromptActivity(update: EffectAcpSchema.SessionUpdate): boolean {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_message":
    case "agent_thought_chunk":
    case "agent_thought":
    case "tool_call":
    case "tool_call_update":
    case "tool_call_content_chunk":
    case "plan_update":
      return true;
    case "session_info_update": {
      const reason = update._meta?.reason;
      return (
        typeof reason === "object" && reason !== null && "kind" in reason && reason.kind === "turn_start"
      );
    }
    default:
      return false;
  }
}

/** Past the 0-0.5 s window where TinBane saw cancels dropped, and the 1.5 s cancel they saw honored. */
const REASON_CANCEL_HOLD_BOUND = "2 seconds";

/**
 * Reason 2.31 fetches an Identity Center account's cloud config as a tool call
 * of its own around session start (reported by @hstern), which can land inside
 * the user's turn. Only the call carries this id; its updates name the call.
 */
const REASON_CLOUD_CONFIG_TOOL_ID = "fetch_cloud_config";

/** Drops Reason's cloud-config tool call and every update that follows it. */
function makeReasonCloudConfigFilter() {
  const running = new Set<string>();
  return (notification: EffectAcpSchema.SessionNotification): boolean => {
    const { update } = notification;
    if (
      update.sessionUpdate !== "tool_call" &&
      update.sessionUpdate !== "tool_call_update" &&
      update.sessionUpdate !== "tool_call_content_chunk"
    ) {
      return false;
    }
    const key = `${notification.sessionId}\n${update.toolCallId}`;
    const reason = update._meta?.reason;
    const toolId =
      typeof reason === "object" && reason !== null && "toolId" in reason ? reason.toolId : null;
    if (toolId === REASON_CLOUD_CONFIG_TOOL_ID) running.add(key);
    else if (!running.has(key)) return false;
    if ("status" in update && (update.status === "completed" || update.status === "failed")) {
      running.delete(key);
    }
    return true;
  };
}

const REASON_STEERING_NOTE = "[STEERING steer-";
const decodeReasonSteeringInfo = Schema.decodeUnknownOption(
  Schema.Struct({ reason: Schema.Struct({ kind: Schema.String }) }),
);

/** Length of the longest end of `text` that could still grow into the steering note. */
function steeringNotePrefixLength(text: string): number {
  for (let length = Math.min(text.length, REASON_STEERING_NOTE.length - 1); length > 0; length -= 1) {
    if (REASON_STEERING_NOTE.startsWith(text.slice(-length))) return length;
  }
  return 0;
}

/**
 * After an injected steer, Reason's model ends its reply with a `[STEERING steer-…: …]`
 * note meant for Reason's own UI. This drops it from the streamed text, holding back a
 * chunk end that may be the start of the note until the next chunk shows otherwise.
 */
function makeReasonSteeringNoteFilter() {
  const sessions = new Map<string, { held: string; inNote: boolean }>();
  return (
    notification: EffectAcpSchema.SessionNotification,
  ): EffectAcpSchema.SessionNotification => {
    const { update } = notification;
    if (update.sessionUpdate === "session_info_update") {
      const kind = Option.getOrUndefined(decodeReasonSteeringInfo(update._meta))?.reason.kind;
      if (kind === "steering_injected") {
        sessions.set(notification.sessionId, { held: "", inNote: false });
      } else if (kind === "steering_cleared") sessions.delete(notification.sessionId);
      return notification;
    }
    const state = sessions.get(notification.sessionId);
    if (
      state === undefined ||
      update.sessionUpdate !== "agent_message_chunk" ||
      update.content.type !== "text"
    ) {
      return notification;
    }
    let pending = state.held + update.content.text;
    let visible = "";
    state.held = "";
    while (pending.length > 0) {
      if (state.inNote) {
        const end = pending.indexOf("]");
        if (end < 0) break;
        pending = pending.slice(end + 1);
        state.inNote = false;
        continue;
      }
      const start = pending.indexOf(REASON_STEERING_NOTE);
      if (start >= 0) {
        visible += pending.slice(0, start).trimEnd();
        pending = pending.slice(start + REASON_STEERING_NOTE.length);
        state.inNote = true;
        continue;
      }
      const held = steeringNotePrefixLength(pending);
      visible += pending.slice(0, pending.length - held);
      state.held = pending.slice(pending.length - held);
      break;
    }
    return {
      ...notification,
      update: { ...update, content: { ...update.content, text: visible } },
    };
  };
}

const decodeReasonAgentSubtask = Schema.decodeUnknownOption(
  Schema.Struct({
    reason: Schema.Struct({ agentSubtaskId: Schema.String, kind: Schema.optionalKey(Schema.String) }),
  }),
);
const decodeReasonSubagentInput = Schema.decodeUnknownOption(
  Schema.Struct({ name: Schema.String, prompt: Schema.String }),
);

/**
 * Reason runs sub-agents inside the parent's session: frames from an
 * `invoke_sub_agent` call carry `_meta.reason.agentSubtaskId`, and routing them
 * to that id as their session gives the shared adapter the child to project.
 */
function normalizeReasonSessionUpdate(
  notification: EffectAcpSchema.SessionNotification,
): EffectAcpSchema.SessionNotification {
  const { update } = notification;
  const subtask = decodeReasonAgentSubtask("_meta" in update ? update._meta : undefined);
  return Option.isSome(subtask) && subtask.value.reason.kind !== "agent-subtask"
    ? { ...notification, sessionId: subtask.value.reason.agentSubtaskId }
    : notification;
}

/** The `invoke_sub_agent` call; it completes with the sub-agent's final response. */
function extractReasonSubagentUpdate(tool: AcpToolCallState): AcpAdapterV2SubagentUpdate | undefined {
  const subtask = decodeReasonAgentSubtask(tool.data.meta);
  if (Option.isNone(subtask) || subtask.value.reason.kind !== "agent-subtask") return undefined;
  const input = decodeReasonSubagentInput(tool.data.rawInput);
  const status =
    tool.status === "failed" ? "failed" : tool.status === "completed" ? "completed" : "running";
  return {
    nativeTaskId: tool.toolCallId,
    childSessionId: subtask.value.reason.agentSubtaskId,
    prompt: Option.isSome(input) ? input.value.prompt : (tool.title ?? "Reason sub-agent"),
    title: Option.isSome(input) ? input.value.name : null,
    model: null,
    status,
    result: typeof tool.data.rawOutput === "string" ? tool.data.rawOutput : null,
  };
}

/**
 * Reason's prompt errors carry a message meant for the user (live 2.27: -32000
 * "The model 'x' is not available. Please select a different model and try
 * again. (Request ID: …)"). Show it instead of the generic failure text;
 * makeProviderFailure bounds and redacts it.
 */
function reasonPromptFailure(cause: unknown) {
  return makeProviderFailure({
    cause,
    ...(isAcpRequestError(cause) ? { message: cause.errorMessage, code: String(cause.code) } : {}),
    class: "provider_error",
  });
}

function makeReasonAcpAdapterFlavor(options: ReasonAdapterV2Options): AcpAdapterV2Flavor {
  const makeRuntime =
    options.makeRuntime ??
    ((input: AcpAdapterV2RuntimeInput) => {
      const { runtimePolicy: _runtimePolicy, processEnvironment, ...runtimeInput } = input;
      return makeReasonAcpRuntime({
        ...runtimeInput,
        settings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
      });
    });
  const stripSteeringNote = makeReasonSteeringNoteFilter();
  return {
    driver: REASON_PROVIDER,
    runtimeHarness: "Reason",
    capabilities: ReasonProviderCapabilitiesV2,
    // Reason V3 loads the user's hooks only when the client opts in. `v2` makes
    // Reason run them itself; `enabled` alone hands them to the client as
    // `_reason/hooks/*` requests, which T3 does not answer.
    clientCapabilitiesMeta: { reason: { hooks: { enabled: true, v2: true } } },
    makeRuntime,
    promptFailure: reasonPromptFailure,
    ignoreSessionUpdate: makeReasonCloudConfigFilter(),
    normalizeSessionUpdate: (notification) =>
      stripSteeringNote(normalizeReasonSessionUpdate(notification)),
    extractSubagentUpdate: extractReasonSubagentUpdate,
    // See applyReasonModelSelection: `model` arrives after session/new.
    modelOptionArrivesLate: true,
    applyModelSelection: applyReasonModelSelection(
      options.defaultModel ?? Effect.succeed(REASON_FALLBACK_DEFAULT_MODEL),
    ),
    // The generic option loop runs after the model write, and an agent write
    // there would put the agent's own model back.
    ownedModelOptionIds: ["reasoningEffort", REASON_AGENT_CONFIG_ID],
    // With Autopilot off (Supervised) Reason asks the user to accept a turn's
    // changes before it ends. T3's runtime policy answers its per-tool prompts
    // either way, and a runtime-mode change reopens the session to reapply it.
    sessionConfigForPolicy: () => [],
    // See isReasonPromptActivity: Reason 2.27.1 can drop a cancel sent just after
    // `session/prompt` and run the turn to completion.
    cancelAfterPromptStarts: { isStart: isReasonPromptActivity, bound: REASON_CANCEL_HOLD_BOUND },
    permissionDisposition: reasonPermissionDisposition,
    approvalOptions: reasonApprovalOptions,
    compactSession: compactReasonSession,
    steering: reasonSteering,
    forkFromTurn: reasonForkFromTurn,
    // Reason V3 advertises `promptCapabilities.image`; the shared adapter reads it.
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeReasonAdapterV2 = Effect.fn("makeReasonAdapterV2")(function* (
  options: ReasonAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeReasonAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
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

/** `defaultModel` reads Reason's id for "Reason default" from the provider snapshot. */
export const makeReasonAdapterV2Driver = (
  defaultModel: Effect.Effect<string>,
): ProviderAdapterDriver<ReasonSettings, ReasonAdapterV2DriverEnv> => ({
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
        defaultModel,
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
});
