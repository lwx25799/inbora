import type { InboundEvent, SendProof } from '../contracts/events.js';
import type { PlatformReplyAdapter } from './platform-connector.js';

/** The caller owns the account actor. Readback never calls prepare or submits. */
export async function readExistingReply(adapter: PlatformReplyAdapter, event: InboundEvent, text: string, boundary: string,
  contextDigest?: string): Promise<SendProof | null> {
  if (adapter.verifyExisting) {
    return event.channel === 'DIRECT_MESSAGE'
      ? adapter.verifyExisting(event, text, boundary, contextDigest)
      : adapter.verifyExisting(event, text, boundary);
  }
  await adapter.inspect(event);
  return adapter.readback(event, text, [], boundary);
}
