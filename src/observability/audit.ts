import pino from 'pino';

const logger = pino({ base: null });
/** No exception messages, URLs, IDs from pages, prompts or message text in logs. */
export function diagnostic(code: string, counts: Record<string, number | boolean> = {}): void {
  logger.info({ code: /^[A-Z0-9_]+$/.test(code) ? code : 'UNCLASSIFIED', counts });
}
