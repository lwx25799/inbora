import { useEffect, useRef, useState } from "react";
import {
  runtimeSession,
  saveBusinessPrompts,
  type BusinessPrompts,
  type Status,
} from "./api";
import { explainSafe } from "./error-messages";
import { businessPrompts, samePrompts } from "./settings-form-sync";

const emptyPrompts: BusinessPrompts = { persona: "", business: "", rules: "" };

export interface BusinessPromptsController {
  prompts: BusinessPrompts;
  promptBusy: boolean;
  promptError: string;
  promptNotice: string;
  canSavePrompts: boolean;
  devRecoveryRestoring: boolean;
  updatePromptField: (field: keyof BusinessPrompts, value: string) => void;
  savePrompts: () => Promise<void>;
}

/**
 * Holds non-secret business prompt drafts, baseline sync, and save feedback at App session scope
 * so switching away from AutomationView during an in-flight save never drops typed edits or results.
 */
export function useBusinessPrompts({
  status,
  devRecoveryGeneration,
  devRecoveryRestoring,
  updatePrompts,
}: {
  status: Status | null;
  devRecoveryGeneration: number;
  devRecoveryRestoring: boolean;
  updatePrompts: (session: string, prompts: BusinessPrompts) => void;
}): BusinessPromptsController {
  const sessionKey = status ? JSON.stringify([runtimeSession(status), devRecoveryGeneration]) : "";
  const incoming = status ? businessPrompts(status.settings) : emptyPrompts;
  const promptsKey = JSON.stringify(incoming);

  const [prompts, setPrompts] = useState<BusinessPrompts>(() => incoming);
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptError, setPromptError] = useState("");
  const [promptNotice, setPromptNotice] = useState("");

  const syncedPrompts = useRef<BusinessPrompts>(incoming);
  const latestPrompts = useRef<BusinessPrompts>(prompts);
  const latestSessionKey = useRef(sessionKey);
  const savingPrompts = useRef(false);
  const mounted = useRef(true);

  latestPrompts.current = prompts;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (latestSessionKey.current !== sessionKey) {
      latestSessionKey.current = sessionKey;
      syncedPrompts.current = incoming;
      latestPrompts.current = incoming;
      savingPrompts.current = false;
      setPrompts(incoming);
      setPromptBusy(false);
      setPromptError("");
      setPromptNotice("");
      return;
    }
    if (samePrompts(latestPrompts.current, syncedPrompts.current)) {
      syncedPrompts.current = incoming;
      latestPrompts.current = incoming;
      setPrompts(incoming);
    }
  }, [sessionKey, promptsKey]);

  const canSavePrompts = status?.modelProvidersSupported === true;

  function updatePromptField(field: keyof BusinessPrompts, value: string): void {
    setPrompts((current) => {
      const next = { ...current, [field]: value };
      latestPrompts.current = next;
      return next;
    });
  }

  async function savePrompts(): Promise<void> {
    if (!status || devRecoveryRestoring || savingPrompts.current || !canSavePrompts) return;
    const expectedSessionKey = sessionKey;
    const expectedSession = runtimeSession(status);
    const snapshotStatus = status;
    const submitted = latestPrompts.current;
    savingPrompts.current = true;
    setPromptBusy(true);
    setPromptError("");
    setPromptNotice("");
    try {
      const next = await saveBusinessPrompts(snapshotStatus, submitted);
      if (!mounted.current || latestSessionKey.current !== expectedSessionKey) return;
      if (runtimeSession(next) !== expectedSession) return;
      const saved = businessPrompts(next.settings);
      syncedPrompts.current = saved;
      if (samePrompts(latestPrompts.current, submitted)) {
        latestPrompts.current = saved;
        setPrompts(saved);
      }
      updatePrompts(expectedSession, saved);
      setPromptNotice("业务提示词已保存");
    } catch (cause) {
      if (mounted.current && latestSessionKey.current === expectedSessionKey) {
        setPromptError(explainSafe(cause, "业务提示词保存失败。"));
      }
    } finally {
      if (latestSessionKey.current === expectedSessionKey) {
        savingPrompts.current = false;
        if (mounted.current) setPromptBusy(false);
      }
    }
  }

  return {
    prompts,
    promptBusy,
    promptError,
    promptNotice,
    canSavePrompts,
    devRecoveryRestoring,
    updatePromptField,
    savePrompts,
  };
}
