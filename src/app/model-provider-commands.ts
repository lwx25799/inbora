import type { ModelProvidersCommand } from "../contracts/model-providers.js";
import { requireSafe } from "../core/contracts.js";
import type { WorkbenchAuthority } from "./authority.js";
import type { ModelProviderController } from "./model-provider-controller.js";

export async function handleModelProviderCommand(authority: WorkbenchAuthority, token: string,
  controller: ModelProviderController | null, unavailable: string | null, closing: () => boolean, command: ModelProvidersCommand) {
  const authorize = () => {
    authority.requireGuiControl(token);
    requireSafe(!closing(), "CLIENT_CLOSING");
  };
  authorize();
  requireSafe(controller, unavailable ?? "MODEL_PROVIDERS_NOT_INITIALIZED");
  return controller.dispatch(command, authorize);
}
