import { createServer, type Server } from 'node:net';
import { mkdir, realpath } from 'node:fs/promises';
import { digest, Blocked } from '../core/contracts.js';

export const ownerLockPortBase = 20_000;
export const ownerLockPortSpan = 29_000;

export function ownerLockPort(canonical: string): number {
  return ownerLockPortBase + (Number.parseInt(digest(canonical).slice(0, 8), 16) % ownerLockPortSpan);
}

export function ownerLockErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES') return 'OWNER_PORT_RESERVED';
  return 'OWNER_LOCKED_OR_PORT_UNAVAILABLE';
}

/** OS-owned socket releases on process death; never guesses stale file-lock ownership. */
export class OwnerLock {
  private closing: Promise<void> | undefined;
  private constructor(private readonly server: Server, readonly port: number) {}
  static async acquire(directory: string, createDirectory = true): Promise<OwnerLock> {
    if(createDirectory)await mkdir(directory, { recursive: true });
    let canonical = await realpath(directory);
    if (process.platform === 'win32') canonical = canonical.toLowerCase();
    const port = ownerLockPort(canonical);
    const server = createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', error => reject(new Blocked(ownerLockErrorCode(error))));
      server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
    return new OwnerLock(server, port);
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closing = new Promise<void>((resolve, reject) => {
        if (!this.server.listening) { resolve(); return; }
        this.server.close(err => err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(err) : resolve());
      });
    }
    return this.closing;
  }
}
