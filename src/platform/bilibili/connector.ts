import { BILIBILI_PLATFORM_ID } from '../../contracts/account.js';
import {
  WebPlatformWorkerConnector,
  webPlatformCapabilities,
  type WebPlatformWorkerConnectorOptions,
} from '../web-platform-worker-connector.js';

export { BILIBILI_PLATFORM_ID };
export const bilibiliCapabilities = webPlatformCapabilities;
export type BilibiliConnectorOptions = Omit<WebPlatformWorkerConnectorOptions, 'platformId'>;

export class BilibiliPlatformConnector extends WebPlatformWorkerConnector {
  constructor(options: BilibiliConnectorOptions) {
    super({ ...options, platformId: BILIBILI_PLATFORM_ID });
  }
}
