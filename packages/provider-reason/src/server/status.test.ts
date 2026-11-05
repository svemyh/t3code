import { describe, expect, it } from "@effect/vitest";

import { buildReasonAcpArgs, reasonInBandFailure } from "./acpSupport.ts";
import { reasonAuthFromSelf, reasonModelsFromList } from "./status.ts";

const ok = (stdout: unknown) => ({ code: 0, stdout: JSON.stringify(stdout) });

describe("buildReasonAcpArgs", () => {
  it.each([
    [{ runsOn: "local", machine: "", workspace: "" }, ["acp", "-y"]],
    [{ runsOn: "cloud", machine: "build", workspace: "" }, ["acp", "-y", "--cloud"]],
    [{ runsOn: "machine", machine: "build", workspace: "" }, ["acp", "-y", "--on", "build"]],
    // An unnamed machine runs here; the status check reports it.
    [{ runsOn: "machine", machine: "", workspace: "" }, ["acp", "-y"]],
    // `--workspace` is a global flag and goes before `acp`.
    [{ runsOn: "local", machine: "", workspace: "acme" }, ["--workspace", "acme", "acp", "-y"]],
  ] as const)("%o", (settings, expected) => {
    expect(buildReasonAcpArgs({ binaryPath: "reason", ...settings })).toEqual(expected);
  });
});

describe("reasonInBandFailure", () => {
  it("reads Reason's failed-request reply (0.2.678 outside the home folder)", () => {
    expect(
      reasonInBandFailure(
        "Reason request failed (404 device_not_found). Run from a folder in your home folder, or add --cloud.",
      ),
    ).toEqual({
      class: "provider_error",
      code: "device_not_found",
      message:
        "Reason request failed (404 device_not_found). Run from a folder in your home folder, or add --cloud.",
      retryable: false,
    });
  });

  it.each([
    ["Reason request failed (429 rate_limited).", "usage_limit", true],
    ["Reason request failed (402 credits_exhausted).", "usage_limit", false],
    ["Reason request failed (401 unauthorized).", "permission_error", false],
    ["Reason request failed (503).", "transport_error", true],
  ] as const)("classifies %s", (text, failureClass, retryable) => {
    expect(reasonInBandFailure(text)).toMatchObject({ class: failureClass, retryable });
  });

  it("leaves ordinary replies alone", () => {
    expect(reasonInBandFailure("The Reason request failed earlier, so I retried.")).toBeUndefined();
  });
});

describe("reasonModelsFromList", () => {
  it("lists visible, available models after Auto, grouped by source", () => {
    const models = reasonModelsFromList(
      ok({
        ok: true,
        data: {
          models: [
            {
              id: "openai/gpt-6.1-sol",
              label: "Reason",
              detail: "Included with Reason",
              reasoning_efforts: ["medium"],
              available: true,
            },
            { id: "openai/gpt-6-luna", label: "Reason", hidden: true, available: true },
            {
              id: "byok:anthropic:claude-opus-5-5",
              label: "Claude Opus 5.5",
              detail: "Claude · Subscription",
              reasoning_efforts: ["low", "high"],
              hidden: false,
              available: true,
            },
            { id: "byok:google:gemini-4-argon", label: "Gemini 4 Argon", available: false },
          ],
        },
      }),
    );
    expect(models?.map((model) => [model.slug, model.name, model.subProvider])).toEqual([
      ["default", "Auto", undefined],
      ["openai/gpt-6.1-sol", "Reason", "Included with Reason"],
      ["byok:anthropic:claude-opus-5-5", "Claude Opus 5.5", "Claude · Subscription"],
    ]);
    // One level is nothing to choose; Reason's `default` leads otherwise.
    expect(models?.[1]?.capabilities?.optionDescriptors).toEqual([]);
    expect(models?.[2]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "reasoning_effort",
      role: "reasoning",
      currentValue: "default",
      options: [{ id: "default" }, { id: "low" }, { id: "high" }],
    });
  });

  it("keeps the built-in list when the call fails", () => {
    expect(reasonModelsFromList(ok({ ok: false, error: { code: "x" } }))).toBeUndefined();
    expect(reasonModelsFromList(undefined)).toBeUndefined();
  });
});

describe("reasonAuthFromSelf", () => {
  it("names the account and organization", () => {
    expect(
      reasonAuthFromSelf(
        ok({
          ok: true,
          data: { principal_type: "user", email: "a@b.co", organization_name: "Acme" },
        }),
        {},
      ),
    ).toEqual({ status: "authenticated", label: "Reason · Acme", email: "a@b.co" });
  });

  it("marks an API key sign-in", () => {
    expect(
      reasonAuthFromSelf(ok({ ok: true, data: {} }), { REASON_API_KEY: "reason_x" }),
    ).toMatchObject({ status: "authenticated", type: "api_key" });
  });

  it("reports signed out only when Reason says so", () => {
    const signedOut = ok({ ok: false, error: { code: "authentication_required" } });
    expect(reasonAuthFromSelf(signedOut, {})).toEqual({ status: "unauthenticated" });
    expect(reasonAuthFromSelf(ok({ ok: false, error: { code: "network" } }), {})).toEqual({
      status: "unknown",
    });
    expect(reasonAuthFromSelf(undefined, {})).toEqual({ status: "unknown" });
  });
});
