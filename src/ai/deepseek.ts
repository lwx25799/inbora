import { randomUUID } from "node:crypto";
import {
  digest,
  requireSafe,
  validText,
  type InboundEvent,
} from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import { prompt, sensitive } from "./draft-service.js";
import {readCommentThreadContext,commentThreadModelHistory} from '../storage/comment-thread-context.js';
import type { AiSettings } from "../app/contracts.js";
import {assertSecurityChannelClear,assertSecurityRevision,securityRevision} from '../storage/security-holds.js';
import {requestDeepSeek} from './deepseek-request.js';
import {buildReplySystemPrompt,classifyModelFailure,wrapModelTransport} from './reply-style.js';
import {knowledgePromptData,assertKnowledgePromptSafe,privateModelText,unsafeModelOutput} from '../knowledge/generation-context.js';
import type {ReplyKnowledgeContext} from '../knowledge/contracts.js';

// Existing cross-module security-hold tests expect DeepSeekProvider in-flight security revision changes to surface as MODEL_FAILED_NO_RETRY.
const deepSeekExcludedFailureCodes = new Set<string>(['SECURITY_STATE_CHANGED']);

export class DeepSeekProvider {
  constructor(private readonly transport: typeof fetch = fetch) {}
  async generate(
    store: EventStore,
    event: InboundEvent,
    history: InboundEvent[],
    settings: AiSettings,
    key: string,
    authorized: boolean,
    signal?: AbortSignal,
    reserve?: () => void,
    validateContext?: (event:InboundEvent,history:InboundEvent[]) => void,
    knowledge?:ReplyKnowledgeContext|null,
  ): Promise<{ text: string; model: string }> {
    requireSafe(
      authorized && key.length > 0,
      "REAL_MODEL_AUTHORIZATION_REQUIRED",
    );
    requireSafe(!/[\r\n]/u.test(key), "INVALID_MODEL_KEY");
    if(event.channel==='COMMENT_NOTIFICATION'&&event.kind==='REPLY')history=commentThreadModelHistory(readCommentThreadContext(store,event),event);
    validateContext?.(event,history);
    const effectiveSettings={...settings,...(knowledge?.persona?{persona:knowledge.persona}:{})};
    requireSafe(
      !sensitive(event) &&
        !history.some(sensitive) &&
        !privateModelText(
          [effectiveSettings.persona, effectiveSettings.business, effectiveSettings.rules].join("\n"),
        ),
      "SENSITIVE_MANUAL_HANDLING",
    );
    const context=prompt(event,history);
    if(knowledge)assertKnowledgePromptSafe(knowledge,event);
    const security=securityRevision(store,event.channel);
    const id = randomUUID();
    store.db
      .transaction(() => {
        assertSecurityChannelClear(store,event.channel);
        store.assertModelObservation(event);
        for(const item of history)store.assertModelObservation(item);
        reserve?.();
        store.consumeBudget("MODEL");
        store.db
          .prepare("INSERT INTO model_calls VALUES(?,?,?,NULL,NULL,NULL,NULL)")
          .run(id, settings.model, "STARTED");
        if(store.db.prepare("SELECT name FROM sqlite_master WHERE name='k_model_purposes'").get())
          store.db.prepare('INSERT INTO k_model_purposes VALUES(?,?,NULL)').run(id,'REPLY_GENERATION');
      })
      .immediate();
    const started = Date.now();
    try {
      const result=await requestDeepSeek(wrapModelTransport(this.transport,signal),{model:settings.model,key,maximumTokens:512,
        ...(signal?{signal}:{}),
        system:buildReplySystemPrompt({baseSystem:context.system,settings:effectiveSettings}),
        data:{...context.businessData as object,...(knowledge?knowledgePromptData(knowledge):{})}});
      // Usage is factual even when the generated text is rejected below.
      store.db
        .prepare(
          "UPDATE model_calls SET input_tokens=?,output_tokens=?,elapsed_ms=? WHERE id=?",
        )
        .run(
          result.inputTokens,
          result.outputTokens,
          Date.now() - started,
          id,
        );
      const text = validText(result.text);
      assertSecurityRevision(store,event.channel,security);
      requireSafe(!unsafeModelOutput(text), "MODEL_SENSITIVE_OUTPUT");
      requireSafe(
        !history.some((h) => h.direction === "OUTGOING" && h.text === text),
        "MODEL_DUPLICATE_OUTPUT",
      );
      store.db
        .prepare("UPDATE model_calls SET status='SUCCEEDED' WHERE id=?")
        .run(id);
      store.audit("DEEPSEEK_SUCCEEDED", digest(id));
      return { text, model: result.model };
    } catch (error) {
      store.db
        .prepare(
          "UPDATE model_calls SET status='FAILED',elapsed_ms=? WHERE id=?",
        )
        .run(Date.now() - started, id);
      const code = classifyModelFailure(error, {
        ...(signal ? { signal } : {}),
        excluded: deepSeekExcludedFailureCodes,
      });
      requireSafe(false, code);
    }
  }
}
