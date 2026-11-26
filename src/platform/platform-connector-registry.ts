import { accountIdSchema, type AccountId } from '../contracts/account.js';
import { requireSafe } from '../core/contracts.js';
import type { PlatformConnector } from './platform-connector.js';

export class PlatformConnectorRegistry {
  private readonly connectors = new Map<string, PlatformConnector>();

  private key(platformId: string, accountId: AccountId): string {
    requireSafe(/^[a-z][a-z0-9-]{0,63}$/u.test(platformId), 'PLATFORM_ID_INVALID');
    requireSafe(accountIdSchema.safeParse(accountId).success, 'ACCOUNT_ID_INVALID');
    return `${platformId}:${accountId}`;
  }

  register(connector: PlatformConnector): void {
    const key = this.key(connector.platformId, connector.accountId);
    requireSafe(!this.connectors.has(key), 'PLATFORM_CONNECTOR_ALREADY_REGISTERED');
    this.connectors.set(key, connector);
  }

  resolve(platformId: string, accountId: AccountId): PlatformConnector {
    const connector = this.connectors.get(this.key(platformId, accountId));
    requireSafe(connector, 'PLATFORM_CONNECTOR_NOT_FOUND');
    return connector;
  }
}
