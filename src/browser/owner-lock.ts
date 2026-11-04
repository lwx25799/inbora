import { createServer, type Server } from 'node:net';
import { mkdir, realpath } from 'node:fs/promises';
import { digest, Blocked } from '../core/contracts.js';

/** OS-owned socket releases on process death; never guesses stale file-lock ownership. */
export class OwnerLock {
  private constructor(private readonly server: Server) {}
  static async acquire(directory: string): Promise<OwnerLock> {
    await mkdir(directory, { recursive: true });
    let canonical = await realpath(directory);
    if (process.platform === 'win32') canonical = canonical.toLowerCase();
    const port = 20_000 + (Number.parseInt(digest(canonical).slice(0, 8), 16) % 40_000);
    const server = createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', () => reject(new Blocked('OWNER_LOCKED_OR_PORT_UNAVAILABLE')));
      server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
    return new OwnerLock(server);
  }
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close(err => err ? reject(err) : resolve()));
  }
}
