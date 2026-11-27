import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { isOfficialApiPlatform } from '../contracts/account.js';
import { Blocked, DEFAULT_ACCOUNT_ID, MOCK_PLATFORM_ID, digest, requireSafe } from '../core/contracts.js';
import { commandSchema } from '../contracts/client.js';
import { MAX_NATIVE_BRIDGE_BYTES } from '../contracts/native-bridge.js';
import {
  isMutatingClientCommand, MAX_PROTOCOL_V2_FRAME_BYTES, PROTOCOL_V1, PROTOCOL_V2, protocolV2RequestEnvelopeSchema,
  requiredScopeForCommand, type ProtocolScope, type ProtocolV2RequestEnvelope,
} from '../contracts/protocol-v2.js';
import { getNativeWin32Bridge } from '../native/win32-bridge.js';
import type { ProtocolCommandInput } from '../storage/account-store.js';
import { findProtocolCommand, type AccountController } from './account-controller.js';
import { isReadOnlySidecarCommand } from './service-guards.js';
import type { ClientService } from './service.js';

export const MAX_V1_FRAME_BYTES = 100_000;
export const nativeResponsePrefix = /^\s*\{\s*(?:"bridgeId"\s*:\s*"[^"]+"\s*,\s*)?"kind"\s*:\s*"native_bridge_response"/u;
const requestIdSchema = z.uuid();
const securityRecoveryStatusSchema = z.object({
  command: z.literal('securityRecovery'), action: z.literal('status'),
}).strict();
const requestV1Schema = z.object({
  protocol: z.literal(PROTOCOL_V1), requestId: requestIdSchema, secret: z.string().length(64), body: z.unknown(),
}).strict();
const sidecarCommandSchema = z.union([
  z.object({ command: z.literal('connect'), runtime: z.string().min(1).max(1000), initialize: z.boolean(),
    consent: z.literal(true) }).strict(),
  z.object({ command: z.literal('disconnect') }).strict(),
  commandSchema,
]);
export type SidecarCommand = z.infer<typeof sidecarCommandSchema> | z.infer<typeof securityRecoveryStatusSchema>;
type SidecarEnvelope = z.infer<typeof requestV1Schema> | ProtocolV2RequestEnvelope;
type ResponseFields = { protocol: SidecarEnvelope['protocol']; requestId: string | null };
type SidecarResponse = ResponseFields & ({ ok: true; result: unknown } | { ok: false; error: string });
type ParsedFrame = { kind: 'native' } | { kind: 'response'; response: SidecarResponse } |
  { kind: 'request'; envelope: SidecarEnvelope };

export function oversizedSidecarFrame(prefix: string): ParsedFrame {
  if (nativeResponsePrefix.test(prefix)) return { kind: 'native' };
  const protocol = /^\s*\{\s*"protocol"\s*:\s*2\s*[,}]/u.test(prefix) ? PROTOCOL_V2 : PROTOCOL_V1;
  const requestId = requestIdSchema.safeParse(/^\s*\{\s*"protocol"\s*:\s*[12]\s*,\s*"requestId"\s*:\s*"([a-f0-9-]{36})"/iu.exec(prefix)?.[1]);
  return { kind: 'response', response: { protocol, requestId: requestId.success ? requestId.data : null,
    ok: false, error: 'IPC_REQUEST_TOO_LARGE' } };
}

export function parseSidecarFrame(line: string, secret: string): ParsedFrame {
  let fields: ResponseFields = { protocol: PROTOCOL_V1, requestId: null };
  const reject = (error: string): ParsedFrame => ({ kind: 'response', response: { ...fields, ok: false, error } });
  const bytes = Buffer.byteLength(line);
  if (bytes > MAX_PROTOCOL_V2_FRAME_BYTES) return oversizedSidecarFrame(line.slice(0, 512));

  let raw: unknown;
  try { raw = JSON.parse(line); }
  catch {
    if (bytes > MAX_V1_FRAME_BYTES) return oversizedSidecarFrame(line.slice(0, 512));
    return reject('OPERATION_FAILED_PRIVATE_DIAGNOSTICS');
  }
  if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'native_bridge_response') {
    if (bytes <= MAX_NATIVE_BRIDGE_BYTES) getNativeWin32Bridge().handleResponse(raw);
    return { kind: 'native' };
  }

  const frame = raw && typeof raw === 'object' ? raw : {};
  const v2 = 'protocol' in frame && frame.protocol === PROTOCOL_V2;
  const requestId = requestIdSchema.safeParse('requestId' in frame ? frame.requestId : undefined);
  fields = { protocol: v2 ? PROTOCOL_V2 : PROTOCOL_V1, requestId: requestId.success ? requestId.data : null };
  if (!v2 && bytes > MAX_V1_FRAME_BYTES) return reject('IPC_REQUEST_TOO_LARGE');
  const envelope = (v2 ? protocolV2RequestEnvelopeSchema : requestV1Schema).safeParse(raw);
  if (!envelope.success) return reject('INVALID_COMMAND');
  fields.requestId = envelope.data.requestId;
  const expected = Buffer.from(secret, 'utf16le');
  const actual = Buffer.from(envelope.data.secret, 'utf16le');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reject('IPC_AUTHENTICATION_FAILED');
  return { kind: 'request', envelope: envelope.data };
}

interface RoutingContext {
  accounts?: AccountController | undefined;
  lifecycleCommandIds: Map<string, string>;
  dispatch(body: SidecarCommand, scope?: ProtocolScope): Promise<unknown>;
  errorCode?(error: unknown): string;
}

export async function dispatchTrustedServiceCommand(service: Pick<ClientService, 'authority' | 'dispatch' | 'accounts'>,
  token: string, body: Exclude<SidecarCommand, { command: 'connect' | 'disconnect' }>, scope?: ProtocolScope): Promise<unknown> {
  if (body.command === 'emergencyStop') {
    // Expiry of the editing session must never put stop behind reconnect or session renewal.
    const stopToken = service.authority.issueSession(['READ', 'CONTROL']);
    try {
      await service.dispatch(stopToken, body);
      return { paused: true, emergencyStopped: true };
    } finally { service.authority.revoke(stopToken); }
  }
  if (body.command === 'securityRecovery' && body.action === 'status') {
    requireSafe(scope?.kind === 'ACCOUNT', 'PROTOCOL_SCOPE_MISMATCH');
    service.authority.renewTrustedSession(token, { readOnly: true });
    service.authority.operator(token, 'READ');
    return service.accounts.securityStatus(scope.accountRef);
  }
  service.authority.renewTrustedSession(token, { readOnly: isReadOnlySidecarCommand(body) });
  return service.dispatch(token, body, scope?.kind === 'ACCOUNT' && body.command !== 'accounts' ? scope.accountRef : undefined);
}

function isLifecycle(body: SidecarCommand): boolean {
  return body.command === 'connect' || body.command === 'disconnect';
}

function parseV2Command(envelope: ProtocolV2RequestEnvelope) {
  const status = securityRecoveryStatusSchema.safeParse(envelope.body);
  if (status.success) return { body: status.data };
  const raw = envelope.body && typeof envelope.body === 'object' ? envelope.body as Record<string, unknown> : {};
  const { commandId: rawBodyId, ...withoutId } = raw;
  const bodyId = typeof rawBodyId === 'string' ? rawBodyId.toLowerCase() : rawBodyId;
  const envelopeId = envelope.commandId?.toLowerCase();
  const commandId = envelopeId ?? bodyId;
  if (envelope.commandId !== undefined && bodyId !== undefined) {
    requireSafe(envelopeId === bodyId, 'COMMAND_ID_CONFLICT');
  }
  const parsed = sidecarCommandSchema.safeParse(bodyId === undefined ? envelope.body : { ...withoutId, commandId: bodyId });
  // Some business schemas require an ID in the body. Normalize envelope-only writes
  // through those same schemas, so they use the existing business ID and ledger.
  const normalized = parsed.success ? parsed : sidecarCommandSchema.safeParse({ ...withoutId, commandId });
  const command = !normalized.success && bodyId !== undefined ? sidecarCommandSchema.safeParse(withoutId) : normalized;
  if (!command.success) {
    if (!requestIdSchema.safeParse(commandId).success && sidecarCommandSchema.safeParse({ ...withoutId,
      commandId: '00000000-0000-4000-8000-000000000000' }).success) throw new Blocked('INVALID_COMMAND_ID');
    throw parsed.error;
  }
  const body = command.data;
  if (isMutatingClientCommand(body) && body.command !== 'emergencyStop' && !isLifecycle(body)) {
    requireSafe(requestIdSchema.safeParse(commandId).success, 'INVALID_COMMAND_ID');
  }
  return { body, commandId: requestIdSchema.safeParse(commandId).data };
}

function sanitizeBodyForDigest(body: SidecarCommand): unknown {
  if (body.command === 'accounts' && body.action === 'configureOfficialChannel') {
    if (body.platform === 'wecom-aibot') {
      const { secret, ...rest } = body;
      return { ...rest, secretSupplied: secret !== undefined };
    }
    const { appSecret, token, encodingAESKey, ...rest } = body;
    return {
      ...rest,
      appSecretSupplied: appSecret !== undefined,
      tokenSupplied: token !== undefined && token !== null,
      aesKeySupplied: encodingAESKey !== undefined && encodingAESKey !== null,
    };
  }
  return body;
}

function isV2OnlyOfficialAccountWrite(body: SidecarCommand): boolean {
  return body.command === 'accounts' && (
    body.action === 'configureOfficialChannel'
    || body.action === 'connectOfficialChannel'
    || body.action === 'disconnectOfficialChannel'
    || body.action === 'reactivateAccount'
  );
}

function reserveCommand({ scope }: ProtocolV2RequestEnvelope, commandId: string | undefined,
  body: SidecarCommand, context: RoutingContext) {
  if (!commandId || body.command === 'emergencyStop' || !isMutatingClientCommand(body)) return;
  const storage = context.accounts?.storage;
  const accountRef = scope.kind === 'ACCOUNT' ? scope.accountRef : null;
  const action = 'action' in body ? body.action : null;
  const requestDigest = digest([scope.kind, accountRef, sanitizeBodyForDigest(body)]);
  const priorLifecycle = context.lifecycleCommandIds.get(commandId);
  if (priorLifecycle !== undefined) {
    requireSafe(priorLifecycle === requestDigest, 'COMMAND_ID_CONFLICT');
    throw new Blocked('COMMAND_REPLAY_BLOCKED');
  }
  if (isLifecycle(body)) {
    requireSafe(!storage || !findProtocolCommand(storage, commandId), 'COMMAND_ID_CONFLICT');
    // Connect and disconnect can run without an open database. Keep their IDs for this pipe's lifetime.
    context.lifecycleCommandIds.set(commandId, requestDigest);
    return;
  }
  requireSafe(context.accounts, 'CONNECT_RUNTIME_FIRST');
  requireSafe(storage, 'SCHEMA4_REQUIRED');
  if (body.command === 'accounts' && (
    body.action === 'registerAccount'
    || body.action === 'disconnectAccount'
    || body.action === 'reactivateAccount'
  )) {
    // AccountStore owns these records and returns the original result on repeat requests.
    context.accounts.validateProtocolWrite(body);
    return;
  }
  const businessReplay = body.command === 'submitManualSend' || body.command === 'sendHumanReply' ||
    body.command === 'sendHumanFollowup' || body.command === 'modelProviders' && 'commandId' in body;
  const record: ProtocolCommandInput = { commandId, scopeKind: scope.kind, accountRef, command: body.command, action,
    requestDigest, status: 'PENDING' };
  const reserved = storage.db.transaction(() => {
    const previous = findProtocolCommand(storage, commandId);
    if (previous) {
      // A pre-normalization business command may still use its original ID in another table.
      requireSafe(previous.commandId === commandId, 'COMMAND_REPLAY_BLOCKED');
      requireSafe(previous.requestDigest === requestDigest && previous.scopeKind === scope.kind &&
        previous.accountRef === accountRef && previous.command === body.command && previous.action === action,
      'COMMAND_ID_CONFLICT');
      if (businessReplay && previous.status === 'COMPLETED') return false;
      if (businessReplay && previous.status === 'FAILED' && previous.errorCode) throw new Blocked(previous.errorCode);
      throw new Blocked('COMMAND_REPLAY_BLOCKED');
    }
    storage.recordProtocolCommand(record);
    return true;
  }).immediate();
  if (!reserved) return;
  return (status: 'COMPLETED' | 'FAILED', errorCode?: string) => {
    // Results of existing commands may contain private data. Replay protection needs only the outcome.
    storage.recordProtocolCommand({ ...record, status, errorCode: errorCode ?? null });
  };
}

export async function routeSidecarEnvelope(envelope: SidecarEnvelope, context: RoutingContext): Promise<SidecarResponse> {
  const { protocol, requestId } = envelope;
  let finish: ReturnType<typeof reserveCommand> = undefined;
  try {
    const parsed = protocol === PROTOCOL_V2 ? parseV2Command(envelope) : { body: sidecarCommandSchema.parse(envelope.body) };
    const { body } = parsed;
    if (protocol === PROTOCOL_V2) {
      const { scope } = envelope;
      const recoveryStatus = body.command === 'securityRecovery' && body.action === 'status';
      requireSafe((recoveryStatus ? 'ACCOUNT' : requiredScopeForCommand(body)) === scope.kind, 'PROTOCOL_SCOPE_MISMATCH');
      if (scope.kind === 'ACCOUNT') {
        if (body.command === 'accounts' && 'accountRef' in body) {
          requireSafe(body.accountRef === scope.accountRef, 'PROTOCOL_SCOPE_MISMATCH');
        } else if (scope.accountRef !== DEFAULT_ACCOUNT_ID) {
          requireSafe(context.accounts, 'CONNECT_RUNTIME_FIRST');
          const account = context.accounts.storage?.getAccount(scope.accountRef);
          requireSafe(account, 'ACCOUNT_NOT_FOUND');
          requireSafe(account.status === 'ACTIVE', account.status === 'DISCONNECTED' ? 'ACCOUNT_DISCONNECTED' : 'ACCOUNT_NOT_ACTIVE');
          const supportedSecondary =
            (account.platform === MOCK_PLATFORM_ID && account.connector === MOCK_PLATFORM_ID) ||
            (isOfficialApiPlatform(account.platform) && account.connector === account.platform);
          requireSafe(supportedSecondary, 'ACCOUNT_COMMAND_NOT_SUPPORTED');
        }
      }
      finish = reserveCommand(envelope, 'commandId' in parsed ? parsed.commandId : undefined, body, context);
    } else {
      requireSafe(!isV2OnlyOfficialAccountWrite(body), 'PROTOCOL_V2_ACCOUNT_SCOPE_REQUIRED');
      if (isMutatingClientCommand(body) && body.command !== 'emergencyStop' && !isLifecycle(body) && !('accountRef' in body)) {
        requireSafe(!context.accounts?.hasMultipleActiveAccounts(), 'PROTOCOL_V2_ACCOUNT_SCOPE_REQUIRED');
      }
    }
    const result = await context.dispatch(body, protocol === PROTOCOL_V2 ? envelope.scope : undefined);
    finish?.('COMPLETED');
    return { protocol, requestId, ok: true, result: result ?? null };
  } catch (error) {
    const code = error instanceof z.ZodError ? 'INVALID_COMMAND' : context.errorCode?.(error) ??
      (error instanceof Blocked ? error.code : 'OPERATION_FAILED_PRIVATE_DIAGNOSTICS');
    try { finish?.('FAILED', code); }
    catch { /* The pending record still prevents this command from running again. */ }
    return { protocol, requestId, ok: false, error: code };
  }
}
