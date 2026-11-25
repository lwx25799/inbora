import {
  requireSafe,
  validText,
  type InboundEvent,
} from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import { prompt, sensitive } from "./draft-service.js";
import {readCommentThreadContext,commentThreadModelHistory} from '../storage/comment-thread-context.js';
import type { AiSettings } from "../app/contracts.js";
import {assertSecurityChannelClear,assertSecurityRevision,securityRevision} from '../storage/security-holds.js';
import { callBusinessModel, type BoundModelCall } from './business-model-call.js';
import {buildReplySystemPrompt,classifyModelFailure} from './reply-style.js';
import {knowledgePromptData,assertKnowledgePromptSafe,assertReplyKnowledgeCurrent,privateModelText,unsafeModelOutput} from '../knowledge/generation-context.js';
import type {ReplyKnowledgeContext} from '../knowledge/contracts.js';

// Existing cross-module security-hold tests expect DeepSeekProvider in-flight security revision changes to surface as MODEL_FAILED_NO_RETRY.
const deepSeekExcludedFailureCodes = new Set<string>(['SECURITY_STATE_CHANGED']);

export class DeepSeekProvider {
  constructor(readonly transport: typeof fetch = fetch) {}
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
    binding?: BoundModelCall,
    validateRoute?: () => void,
  ): Promise<{ text: string; model: string; callId: string }> {
    requireSafe(
      authorized && (binding || key.length > 0),
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
    const check = () => {
      assertSecurityRevision(store, event.channel, security);
      assertSecurityChannelClear(store, event.channel);
      store.assertModelObservation(event);
      for (const item of history) store.assertModelObservation(item);
      assertReplyKnowledgeCurrent(store, knowledge);
      validateRoute?.();
    };
    check();
    try {
      const result = await callBusinessModel({
        store, purpose: "REPLY_GENERATION", model: settings.model, key, signal, binding, transport: this.transport,
        messages: [
          { role: "system", content: buildReplySystemPrompt({ baseSystem: context.system, settings: effectiveSettings }) },
          { role: "user", content: JSON.stringify({ ...context.businessData as object, ...(knowledge ? knowledgePromptData(knowledge) : {}) }) },
        ],
        check,
        reserve: () => reserve?.(),
        validate: result => {
          const text = validText(result.text);
          requireSafe(!unsafeModelOutput(text), "MODEL_SENSITIVE_OUTPUT");
          requireSafe(!history.some(h => h.direction === "OUTGOING" && h.text === text), "MODEL_DUPLICATE_OUTPUT");
          return text;
        },
      });
      return result;
    } catch (error) {
      if (binding) throw error;
      requireSafe(false, classifyModelFailure(error, { ...(signal ? { signal } : {}), excluded: deepSeekExcludedFailureCodes }));
    }
  }
}
