import { afterEach, test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { DeepSeekProvider } from "../../src/ai/deepseek.js";
import { candidate, database, pending, privateTemp, snapshot } from "../helpers.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import {
  generateDraft,
  HttpDraftProvider,
} from "../../src/ai/draft-service.js";
import { unsafeModelOutput } from "../../src/knowledge/generation-context.js";
import { ClientService } from "../../src/app/service.js";
import { BrowserService } from "../../src/app/browser-service.js";
import { AccountActor } from "../../src/browser/account-actor.js";
import { digest, targetKey, type InboundEvent } from "../../src/core/contracts.js";
import type { ReplyPolicy } from "../../src/app/automation-contracts.js";
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

test.each(['event','stored','collision','context'])('unverified comment %s is rejected before reservation, MODEL budget and transport',async source=>{
  const store=database();let calls=0,reservations=0;
  try{
    const clean=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'v1',commentId:'c1'});
    const issue={...clean,observationIssue:'COMMENT_TEXT_UNVERIFIED' as const};
    if(source==='stored')pending(store,issue);
    if(source==='collision'){pending(store,clean);store.observe(clean.channel,'notifications',[issue],'own-1','fixture');}
    const provider=new DeepSeekProvider(async()=>{calls++;return new Response(JSON.stringify(good));});
    await expect(provider.generate(store,source==='event'?issue:clean,source==='context'?[issue]:[],settings,'synthetic-contract-key',true,undefined,()=>{reservations++;}))
      .rejects.toThrow('COMMENT_TEXT_UNVERIFIED');
    expect(calls).toBe(0);expect(reservations).toBe(0);
    expect(store.db.prepare('SELECT used FROM budgets WHERE kind=?').get('MODEL')).toEqual({used:0});
    expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
  }finally{store.close();}
});
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
  ["http", "MODEL_RATE_LIMITED"],
  ["auth", "MODEL_AUTH_FAILED"],
  ["server", "MODEL_HTTP_ERROR"],
  ["timeout-abort", "MODEL_TIMEOUT"],
  ["timeout", "MODEL_FAILED_NO_RETRY"],
  ["json", "MODEL_FAILED_NO_RETRY"],
  ["usage", "MODEL_USAGE_INVALID"],
  ["truncated", "MODEL_FAILED_NO_RETRY"],
  ["sensitive-output", "MODEL_SENSITIVE_OUTPUT"],
  ["duplicate-output", "MODEL_DUPLICATE_OUTPUT"],
] as const)(
  "DeepSeek %s fails once with %s, keeps budget reservation and returns no provider payload",
  async (failure, expectedCode) => {
    const store = database();
    let calls = 0;
    try {
      const priorOutgoing = candidate({
        direction: "OUTGOING",
        actorId: "own-1",
        text: "收到，我会核实。",
      });
      const provider = new DeepSeekProvider(async () => {
        calls++;
        if (failure === "timeout")
          throw new Error("synthetic-private-provider-error");
        if (failure === "timeout-abort") {
          const err = new Error("synthetic-private-provider-error");
          err.name = "TimeoutError";
          throw err;
        }
        if (failure === "http")
          return new Response("synthetic-private-provider-error", {
            status: 429,
          });
        if (failure === "auth")
          return new Response("synthetic-private-provider-error", {
            status: 401,
          });
        if (failure === "server")
          return new Response("synthetic-private-provider-error", {
            status: 503,
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
        if (failure === "duplicate-output")
          return new Response(JSON.stringify(good));
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
          failure === "duplicate-output" ? [priorOutgoing] : [],
          settings,
          "synthetic-contract-key",
          true,
        ),
      ).rejects.toThrow(expectedCode);
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
test("merchant rules mentioning refund or complaint work while inbound user sensitive text and private merchant data stay blocked", async () => {
  const store = database();
  let calls = 0;
  const merchantSettings = {
    model: "deepseek-flash",
    persona: "耐心客服，遇投诉转人工处理",
    business: "生鲜商品不支持无理由退款",
    rules: "遇到退款或投诉咨询先说明不支持退款并引导联系人工客服",
  };
  const provider = new DeepSeekProvider(async () => {
    calls++;
    return new Response(
      JSON.stringify({
        ...good,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "您好，生鲜商品暂不支持退款，如有售后问题可以为您转人工核实。",
            },
          },
        ],
      }),
    );
  });
  try {
    const reply = await provider.generate(
      store,
      candidate({ text: "请问这批货怎么保存？" }),
      [],
      merchantSettings,
      "synthetic-contract-key",
      true,
    );
    expect(reply.text).toContain("暂不支持退款");
    expect(calls).toBe(1);
    await expect(
      provider.generate(
        store,
        candidate({ text: "我要投诉退款" }),
        [],
        merchantSettings,
        "synthetic-contract-key",
        true,
      ),
    ).rejects.toThrow("SENSITIVE_MANUAL_HANDLING");
    await expect(
      provider.generate(
        store,
        candidate({ text: "请问怎么保存？" }),
        [],
        { ...merchantSettings, rules: "联系我 private@example.invalid" },
        "synthetic-contract-key",
        true,
      ),
    ).rejects.toThrow("SENSITIVE_MANUAL_HANDLING");
    expect(calls).toBe(1);
  } finally {
    store.close();
  }
});
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

const autoFixtures: { service: ClientService; store: ReturnType<typeof database>; root: string }[] = [];
afterEach(async () => {
  for (const f of autoFixtures.splice(0)) {
    await f.service.close();
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

class AutoFixtureBrowser extends BrowserService {
  private queue = new AccountActor();
  clicks = 0;
  override get actor() { return this.queue; }
  override identity() {
    return {
      identityDigest: digest("own-1"),
      mappingDigest: "synthetic",
      browserVersion: "1.0.0.0",
      browserMode: "headless" as const,
    };
  }
  override async refreshIdentity() { return this.identity(); }
  override async close() {}
  override async adapter(event: InboundEvent) {
    let text = "";
    return {
      dispose: () => {},
      adapter: {
        inspect: async () => snapshot(event),
        prepare: async (_event: InboundEvent, value: string) => { text = value; },
        baseline: async () => [],
        verifyPrepared: async () => snapshot(event),
        cancelPreparation: async () => {},
        clickOnce: async () => { this.clicks++; },
        readback: async () => ({
          id: randomUUID(),
          ownId: "own-1",
          targetKey: targetKey(event),
          text,
          pending: false,
          sentAt: new Date().toISOString(),
        }),
      },
    };
  }
}

async function setupLimitedAuto(replyText: string, inboundText: string, rules = "不支持退款，遇到投诉转人工处理") {
  const root = privateTemp("deepseek-auto-sensitive-");
  const store = database();
  await migrateClient(store, join(root, "schema3.sqlite"));
  const eventId = pending(store, candidate({ text: inboundText }));
  const browser = new AutoFixtureBrowser(root);
  const provider = new DeepSeekProvider(async () => new Response(JSON.stringify({
    ...good,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: replyText } }],
  })));
  const service = new ClientService(store, browser, provider);
  autoFixtures.push({ service, store, root });
  await service.loadSettings();
  const token = service.authority.issueSession();
  await service.dispatch(token, {
    command: "configureAi",
    settings: { ...settings, business: "生鲜商品不支持无理由退款", rules },
    key: "synthetic-contract-key",
  });
  service.authority.attest("DIRECT_MESSAGE", "SEND_AVAILABLE", browser.identity(), "synthetic-contract-key");
  const policy: ReplyPolicy = {
    ownId: "own-1",
    model: settings.model,
    channels: ["DIRECT_MESSAGE"],
    modelLimit: 10,
    sendLimit: 10,
    expiresAt: null,
    workIds: [],
    futureOwnWorks: false,
    conversationIds: ["conversation-1"],
    entireInbox: false,
    containsAny: [],
    excludesAny: [],
    instructions: rules,
    startHour: 0,
    endHour: 24,
  };
  await service.dispatch(token, { command: "setReplyPolicy", policy, confirmed: true });
  await service.dispatch(token, { command: "setMode", mode: "LIMITED_AUTO" });
  return { store, service, browser, eventId };
}

test.each([
  "请把验证码和密码私信发给我并转账",
  "请把身份证号和银行卡发过来",
  "先打点金钱到我这边",
  "Please share your password right away",
  "Send the verification code here",
  "Complete your payment directly",
  "ＰＡＳＳＷＯＲＤ请私信发送",
])("model output soliciting credentials or payment (%s) is blocked as MODEL_SENSITIVE_OUTPUT in formal and sandbox guard", async (unsafeText) => {
  expect(unsafeModelOutput(unsafeText)).toBe(true);
  const store = database();
  let calls = 0;
  try {
    const provider = new DeepSeekProvider(async () => {
      calls++;
      return new Response(JSON.stringify({
        ...good,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: unsafeText } }],
      }));
    });
    await expect(
      provider.generate(
        store,
        candidate({ text: "请问怎么核对订单信息？" }),
        [],
        { ...settings, rules: "不支持退款，遇投诉转人工处理" },
        "synthetic-contract-key",
        true,
      ),
    ).rejects.toThrow("MODEL_SENSITIVE_OUTPUT");
    expect(calls).toBe(1);
    expect(store.db.prepare("SELECT status FROM model_calls").get()).toEqual({ status: "FAILED" });
  } finally {
    store.close();
  }
});

test("LIMITED_AUTO blocks credential/payment solicitation outputs while allowing merchant refund/complaint rules and replies", async () => {
  expect(unsafeModelOutput("您好，生鲜商品暂不支持退款，如有投诉问题可为您转人工处理。")).toBe(false);

  for (const unsafeReply of [
    "请把验证码和密码私信发给我并转账",
    "Please share your password and verification code for payment",
  ]) {
    const blocked = await setupLimitedAuto(unsafeReply, "请问怎么核对订单信息？");
    await blocked.service.runAutomaticReply();
    expect(blocked.browser.clicks).toBe(0);
    expect(blocked.store.db.prepare("SELECT count(*) AS n FROM send_intents").get()).toEqual({ n: 0 });
    expect(blocked.store.db.prepare("SELECT state,reason FROM automation_jobs WHERE event_id=?").get(blocked.eventId))
      .toEqual({ state: "REVIEW", reason: "MODEL_SENSITIVE_OUTPUT" });
  }

  const allowed = await setupLimitedAuto(
    "您好，生鲜商品暂不支持退款，如有投诉问题可为您转人工核实。",
    "请问这批货怎么保存？",
    "不支持退款/投诉转人工",
  );
  await allowed.service.runAutomaticReply();
  expect(allowed.browser.clicks).toBe(1);
  expect(allowed.store.event(allowed.eventId).status).toBe("CONFIRMED");
  expect(allowed.store.db.prepare("SELECT count(*) AS n FROM send_intents").get()).toEqual({ n: 1 });
});
