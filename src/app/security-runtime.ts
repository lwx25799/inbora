import {createHash} from 'node:crypto';
import {hasVisibleSecurityComponent} from '../adapters/security-components.js';
import {captureObserved} from '../adapters/observed-capture.js';
import {captureCommentThread} from '../adapters/comment-thread-capture.js';
import {captureDmReply} from '../adapters/observed-dm-reply.js';
import {captureCommentReply} from '../adapters/observed-comment-reply.js';
import {captureAndGuard} from '../adapters/click-guard.js';
import {inspectMessageImage} from '../adapters/message-preview.js';
import {inspectMessageShare} from '../adapters/message-share.js';
import {visibleStoredMessage} from '../adapters/message-view-location.js';
import {inspectSecuritySignal} from '../adapters/security-inspection.js';
import {isSecurityFailure,parseSecuritySignal,reportSecurityFailure} from '../adapters/security-signal.js';
import {globalStopCodes,platformStopCodes,securityCandidateCodes,shouldStopGlobally} from '../core/emergency-stop.js';
import {assertSecurityChannelClear,securityRevision,assertSecurityRevision,holdSecurityChannel,resolveSecurityHold,readSecurityHold} from '../storage/security-holds.js';
import {ManualRecovery} from '../browser/manual-recovery.js';
import {manualRecoveryElements,inspectManualRecoveryElement} from '../browser/manual-recovery-dom.js';
import type {SecurityRuntime} from '../contracts/diagnostics.js';
export type {SecurityRuntime} from '../contracts/diagnostics.js';

export const securityRuleVersion='2026-11-16.2';
// Fixed when this module loads. File timestamps or later disk edits cannot change this instance's claim.
const fingerprint=createHash('sha256').update(JSON.stringify({
  ruleVersion:securityRuleVersion,
  globalStopCodes,
  securityCandidateCodes:[...securityCandidateCodes].sort(),
  dispositions:platformStopCodes.map(code=>({code,global:shouldStopGlobally(code),candidate:securityCandidateCodes.has(code)})),
  functions:{hasVisibleSecurityComponent,captureObserved,captureCommentThread,captureDmReply,
    captureCommentReply,captureAndGuard,inspectMessageImage,inspectMessageShare,visibleStoredMessage,inspectSecuritySignal,
    isSecurityFailure,parseSecuritySignal,reportSecurityFailure,shouldStopGlobally,
    assertSecurityChannelClear,securityRevision,assertSecurityRevision,holdSecurityChannel,resolveSecurityHold,readSecurityHold,
    ManualRecovery,manualRecoveryElements,inspectManualRecoveryElement},
},(_key,value:unknown)=>typeof value==='function'?value.toString():value)).digest('hex');

export function securityRuntime(instanceId:string|null):SecurityRuntime {
  return {ruleVersion:securityRuleVersion,fingerprint,instanceId};
}
