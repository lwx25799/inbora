import { XIAOHONGSHU_PLATFORM_ID } from '../../contracts/account.js';
import {
  WebPlatformWorkerConnector,
  webPlatformCapabilities,
  type WebPlatformWorkerConnectorOptions,
} from '../web-platform-worker-connector.js';

export { XIAOHONGSHU_PLATFORM_ID };
export const xiaohongshuCapabilities = webPlatformCapabilities;
export type XiaohongshuConnectorOptions = Omit<WebPlatformWorkerConnectorOptions, 'platformId'>;

export class XiaohongshuPlatformConnector extends WebPlatformWorkerConnector {
  constructor(options: XiaohongshuConnectorOptions) {
    super({ ...options, platformId: XIAOHONGSHU_PLATFORM_ID });
  }
}
