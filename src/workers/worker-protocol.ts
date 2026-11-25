import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import {
  MAX_WORKER_FRAME_BYTES, WorkerRequestEnvelopeSchema, WorkerResponseEnvelopeSchema,
  type WorkerRequestEnvelope, type WorkerResponseEnvelope,
} from '../contracts/browser-worker.js';
import { Blocked, requireSafe } from '../core/contracts.js';
import type { InboundEvent, SendProof } from '../contracts/events.js';

export type WorkerMode = 'synthetic' | 'browser';
export interface WorkerHello {
  pid: number;
  sessionId: string;
  ownerEpoch: number;
  profileLocked: true;
  mode: WorkerMode;
}
export interface WorkerStatus extends WorkerHello {
  state: 'OPEN' | 'CLOSED';
  executedCount: number;
  version?: string;
  pageCount?: number;
}
export interface WorkerObservation {
  scope: string;
  ownId: string;
  events: InboundEvent[];
  evidenceId: string;
}
export interface WorkerIdentity {
  ownId: string;
  mappingDigest: string;
  browserVersion: string;
}
export interface WorkerSendEvidence {
  intentId: string;
  nonce: string;
  executedAt: string;
  evidenceDigest: string;
}
export type WorkerReadback = { verified: true; evidence: WorkerSendEvidence; proof?: SendProof } |
  { verified: false; evidence: null };

// Both directions accept reverse permit frames alongside their ordinary RPC envelopes.
const permitEnvelope = WorkerRequestEnvelopeSchema.pick({ id: true, sessionId: true, ownerEpoch: true });
const permitCheckSchema = permitEnvelope.extend({ kind: z.literal('permitCheck'), nonce: z.uuid() });
const permitErrorSchema = z.enum(['EMERGENCY_STOPPED', 'WORKER_SEND_PERMIT_EXPIRED']);
const permitResultSchema = permitEnvelope.extend({ kind: z.literal('permitResult'), error: permitErrorSchema.nullable() });
const workerInputSchema = z.union([WorkerRequestEnvelopeSchema, permitResultSchema]);
const workerOutputSchema = z.union([WorkerResponseEnvelopeSchema, permitCheckSchema]);
export type WorkerPermitCheck = z.infer<typeof permitCheckSchema>;
export type WorkerPermitResult = z.infer<typeof permitResultSchema>;
export type WorkerPermitError = z.infer<typeof permitErrorSchema>;

export function workerTextDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function encode(value: unknown): Buffer {
  const json = JSON.stringify(value);
  // The limit applies to the encoded payload. LF delimits the frames.
  requireSafe(Buffer.byteLength(json, 'utf8') <= MAX_WORKER_FRAME_BYTES, 'WORKER_FRAME_TOO_LARGE');
  return Buffer.from(json + '\n', 'utf8');
}

export function encodeWorkerRequest(request: WorkerRequestEnvelope): Buffer {
  const parsed = WorkerRequestEnvelopeSchema.safeParse(request);
  requireSafe(parsed.success, 'WORKER_REQUEST_INVALID');
  return encode(parsed.data);
}

export function encodeWorkerResponse(response: WorkerResponseEnvelope): Buffer {
  const parsed = WorkerResponseEnvelopeSchema.safeParse(response);
  requireSafe(parsed.success, 'WORKER_RESPONSE_INVALID');
  return encode(parsed.data);
}

export function encodeWorkerPermitCheck(check: WorkerPermitCheck): Buffer { return encode(permitCheckSchema.parse(check)); }
export function encodeWorkerPermitResult(result: WorkerPermitResult): Buffer { return encode(permitResultSchema.parse(result)); }

async function* readFrames(stream: Readable): AsyncGenerator<unknown> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    requireSafe(Buffer.isBuffer(chunk), 'WORKER_FRAME_NOT_BINARY');
    for (let start = 0; start < chunk.length;) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline < 0 ? chunk.length : newline;
      bytes += end - start;
      requireSafe(bytes <= MAX_WORKER_FRAME_BYTES, 'WORKER_FRAME_TOO_LARGE');
      if (end > start) parts.push(chunk.subarray(start, end));
      if (newline < 0) break;
      let frame: unknown;
      try {
        frame = JSON.parse(decoder.decode(Buffer.concat(parts, bytes)));
      } catch {
        throw new Blocked('WORKER_FRAME_INVALID');
      }
      parts = [];
      bytes = 0;
      yield frame;
      start = newline + 1;
    }
  }
  requireSafe(bytes === 0, 'WORKER_FRAME_TRUNCATED');
}

async function* readEnvelopes<T>(stream: Readable, schema: z.ZodType<T>, error: string): AsyncGenerator<T> {
  for await (const frame of readFrames(stream)) {
    const parsed = schema.safeParse(frame);
    requireSafe(parsed.success, error);
    yield parsed.data;
  }
}

export function readWorkerRequests(stream: Readable): AsyncGenerator<WorkerRequestEnvelope> {
  return readEnvelopes(stream, WorkerRequestEnvelopeSchema, 'WORKER_REQUEST_INVALID');
}

export function readWorkerResponses(stream: Readable): AsyncGenerator<WorkerResponseEnvelope> {
  return readEnvelopes(stream, WorkerResponseEnvelopeSchema, 'WORKER_RESPONSE_INVALID');
}

export function readWorkerInput(stream: Readable) { return readEnvelopes(stream, workerInputSchema, 'WORKER_REQUEST_INVALID'); }
export function readWorkerOutput(stream: Readable) { return readEnvelopes(stream, workerOutputSchema, 'WORKER_RESPONSE_INVALID'); }
