import { test, expect } from "vitest";
import { DeepSeekProvider } from "../../src/ai/deepseek.js";
import { candidate, database } from "../helpers.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import {
  generateDraft,
  HttpDraftProvider,
} from "../../src/ai/draft-service.js";
import { pending, privateTemp } from "../helpers.js";
import { join } from "node:path";

const settings = {
  model: "deepseek-flash",
  persona: "本地客服",
  business: "不承诺未知事实",
  rules: "简短、礼貌",
};
const good = {
  model: "deepseek-flash",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "收到，我会核实。" },
    },
  ],
  usage: { prompt_tokens: 18, completion_tokens: 7, total_tokens: 25 },
};
test("schema3 old CLI draft path fails before model budget or request", async () => {
  const store = database();
  let calls = 0;
  try {
    const eventId = pending(store);
    await migrateClient(
      store,
      join(privateTemp("legacy-model-"), "backup.sqlite"),
    );
    const provider = new HttpDraftProvider(
      {
        endpoint: "https://synthetic.invalid/model",
        model: "synthetic-model",
        approvedAt: new Date().toISOString(),
      },
      "synthetic-contract-key",
      async () => {
        calls++;
        return new Response(
          JSON.stringify({
            text: "legacy text",
            model: "synthetic-model",
            usage: { inputTokens: 1, outputTokens: 1 },
            estimatedCost: null,
          }),
        );
      },
    );
    await expect(generateDraft(store, eventId, provider)).rejects.toThrow(
      "CLIENT_USE_VERSIONED_DRAFT_SERVICE",
    );
    expect(calls).toBe(0);
    expect(
      store.db.prepare("SELECT used FROM budgets WHERE kind=?").get("MODEL"),
    ).toEqual({ used: 0 });
  } finally {
    store.close();
  }
});
test("DeepSeek uses independent official messages/choices/usage contract and limited explicit request", async () => {
  const store = database();
  let calls = 0;
  try {
    const provider = new DeepSeekProvider(async (url, init) => {
      calls++;
      expect(url).toBe("https://api.deepseek.com/chat/completions");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(init!.body as string) as {
        max_tokens: number;
        stream: boolean;
        thinking: unknown;
        messages: { role: string; content: string }[];
      };
      expect(body).toMatchObject({
        max_tokens: 512,
        stream: false,
        thinking: { type: "disabled" },
      });
      expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(body.messages[1]!.content).not.toContain("peer-1");
      expect(body.messages[1]!.content).not.toContain("own-1");
      return new Response(JSON.stringify(good));
    });
    await expect(
      provider.generate(
        store,
        candidate(),
        [],
        settings,
        "synthetic-contract-key",
        false,
      ),
    ).rejects.toThrow("REAL_MODEL_AUTHORIZATION_REQUIRED");
    expect(calls).toBe(0);
    expect(
      await provider.generate(
        store,
        candidate(),
        [],
        settings,
        "synthetic-contract-key",
        true,
      ),
    ).toEqual({ text: "收到，我会核实。", model: "deepseek-flash" });
    expect(
      store.db
        .prepare("SELECT status,input_tokens,output_tokens FROM model_calls")
        .get(),
    ).toEqual({ status: "SUCCEEDED", input_tokens: 18, output_tokens: 7 });
    expect(calls).toBe(1);
  } finally {
    store.close();
  }
});
test.each([
  "http",
  "timeout",
  "json",
  "usage",
  "truncated",
  "sensitive-output",
] as const)(
  "DeepSeek %s fails once, keeps budget reservation and returns no provider payload",
  async (failure) => {
    const store = database();
    let calls = 0;
    try {
      const provider = new DeepSeekProvider(async () => {
        calls++;
        if (failure === "timeout")
          throw new Error("synthetic-private-provider-error");
        if (failure === "http")
          return new Response("synthetic-private-provider-error", {
            status: 429,
          });
        if (failure === "json") return new Response("{");
        if (failure === "usage")
          return new Response(
            JSON.stringify({
              ...good,
              usage: {
                prompt_tokens: 18,
                completion_tokens: 7,
                total_tokens: 99,
              },
            }),
          );
        if (failure === "truncated")
          return new Response(
            JSON.stringify({
              ...good,
              choices: [{ ...good.choices[0], finish_reason: "length" }],
            }),
          );
        return new Response(
          JSON.stringify({
            ...good,
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "https://synthetic.invalid/",
                },
              },
            ],
          }),
        );
      });
      await expect(
        provider.generate(
          store,
          candidate(),
          [],
          settings,
          "synthetic-contract-key",
          true,
        ),
      ).rejects.toThrow("MODEL_FAILED_NO_RETRY");
      expect(calls).toBe(1);
      expect(
        store.db.prepare("SELECT used FROM budgets WHERE kind=?").get("MODEL"),
      ).toEqual({ used: 1 });
      expect(store.db.prepare("SELECT status FROM model_calls").get()).toEqual({
        status: "FAILED",
      });
      expect(
        JSON.stringify(store.db.prepare("SELECT * FROM audit_events").all()),
      ).not.toContain("synthetic-private-provider-error");
    } finally {
      store.close();
    }
  },
);
test("sensitive same-target context blocks before reservation; no Key leaves zero calls", async () => {
  const store = database();
  let calls = 0;
  const provider = new DeepSeekProvider(async () => {
    calls++;
    return new Response(JSON.stringify(good));
  });
  try {
    await expect(
      provider.generate(
        store,
        candidate({ text: "请发到 fixture@example.invalid" }),
        [],
        settings,
        "synthetic-contract-key",
        true,
      ),
    ).rejects.toThrow("SENSITIVE_MANUAL_HANDLING");
    expect(calls).toBe(0);
    expect(
      store.db.prepare("SELECT used FROM budgets WHERE kind=?").get("MODEL"),
    ).toEqual({ used: 0 });
  } finally {
    store.close();
  }
});
