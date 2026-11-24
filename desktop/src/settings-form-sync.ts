import type { AiSettings, Status } from './api.js';

export interface CollectionForm {
  comments: boolean;
  inbox: boolean;
  commentSeconds: number;
  dmSeconds: number;
}

export interface PolicyForm {
  commentReply: boolean;
  dmReply: boolean;
  replyToNestedComments: boolean;
  workIds: string;
  conversations: string;
  future: boolean;
  entireInbox: boolean;
  excludes: string;
  instructions: string;
  modelLimit: number;
  sendLimit: number;
  startHour: number;
  endHour: number;
  unlimitedModel: boolean;
  unlimitedSend: boolean;
}

export function sameAiSettings(a: AiSettings, b: AiSettings): boolean {
  return (
    a.model === b.model &&
    a.persona === b.persona &&
    a.business === b.business &&
    a.rules === b.rules
  );
}

export function collectionSnapshot(status: Status): CollectionForm {
  const collection = status.automation?.collection;
  return {
    comments: collection?.comments ?? false,
    inbox: collection?.inbox ?? false,
    commentSeconds: (collection?.commentIntervalMs ?? 30_000) / 1000,
    dmSeconds: (collection?.dmIntervalMs ?? 15_000) / 1000,
  };
}

export function sameCollectionForm(a: CollectionForm, b: CollectionForm): boolean {
  return (
    a.comments === b.comments &&
    a.inbox === b.inbox &&
    a.commentSeconds === b.commentSeconds &&
    a.dmSeconds === b.dmSeconds
  );
}

export function policySnapshot(status: Status): PolicyForm {
  const state = status.automation;
  const saved = state?.replyPolicy?.scope;
  const savedModelLimit = saved ? saved.modelLimit : state?.modelGrant?.scope.modelLimit;
  return {
    commentReply: saved?.channels.includes('COMMENT_NOTIFICATION') ?? true,
    dmReply: saved?.channels.includes('DIRECT_MESSAGE') ?? true,
    replyToNestedComments: saved?.replyToNestedComments !== false,
    workIds: saved?.workIds.join('\n') ?? '',
    conversations: saved?.conversationIds.join('\n') ?? '',
    future: saved?.futureOwnWorks ?? false,
    entireInbox: saved?.entireInbox ?? false,
    excludes: saved?.excludesAny.join(', ') ?? '',
    instructions: saved?.instructions ?? status.settings.rules,
    modelLimit: savedModelLimit ?? 1,
    sendLimit: saved?.sendLimit ?? 1,
    startHour: saved?.startHour ?? 0,
    endHour: saved?.endHour ?? 24,
    unlimitedModel: savedModelLimit === null,
    unlimitedSend: saved?.sendLimit === null,
  };
}

export function samePolicyForm(a: PolicyForm, b: PolicyForm): boolean {
  return (
    a.commentReply === b.commentReply &&
    a.dmReply === b.dmReply &&
    a.replyToNestedComments === b.replyToNestedComments &&
    a.workIds === b.workIds &&
    a.conversations === b.conversations &&
    a.future === b.future &&
    a.entireInbox === b.entireInbox &&
    a.excludes === b.excludes &&
    a.instructions === b.instructions &&
    a.modelLimit === b.modelLimit &&
    a.sendLimit === b.sendLimit &&
    a.startHour === b.startHour &&
    a.endHour === b.endHour &&
    a.unlimitedModel === b.unlimitedModel &&
    a.unlimitedSend === b.unlimitedSend
  );
}

export function policySyncKey(status: Status): string {
  const state = status.automation;
  return JSON.stringify({
    policyVersion: state?.replyPolicy?.version ?? null,
    policyScope: state?.replyPolicy?.scope ?? null,
    grantVersion: state?.modelGrant?.version ?? null,
    grantScope: state?.modelGrant?.scope ?? null,
    fallbackRules: state?.replyPolicy ? null : status.settings.rules,
  });
}
