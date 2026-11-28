import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { DEFAULT_ACCOUNT_ID } from "../../../src/contracts/account.js";
import type { AccountAiFeatures } from "../../../src/contracts/ai-runtime.js";
import { requestForAccount } from "@/api";
import { AutoReplySwitch } from "@/components/AutoReplySwitch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardFrame,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
} from "@/components/ui/card";
import { explainSafe } from "@/error-messages";
import { resetAvatarPreviewCache } from "@/useAvatarPreview";

export interface AccountAvatarSyncCardProps {
  accountRef?: string | null;
  accountLabel?: string | null;
  disabled?: boolean;
  offline?: boolean;
}

function isValidAccountAiFeatures(value: unknown): value is AccountAiFeatures {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AccountAiFeatures>;
  return (
    typeof candidate.visionEnabled === "boolean" &&
    typeof candidate.mediaReplyEnabled === "boolean" &&
    typeof candidate.syncCustomerAvatars === "boolean" &&
    Array.isArray(candidate.enabledBusinessTools) &&
    Boolean(candidate.toolEndpoints && typeof candidate.toolEndpoints === "object")
  );
}

export function AccountAvatarSyncCard({
  accountRef,
  accountLabel,
  disabled = false,
  offline = false,
}: AccountAvatarSyncCardProps): React.ReactElement {
  const resolvedAccountRef = accountRef?.trim() || DEFAULT_ACCOUNT_ID;
  const [features, setFeatures] = useState<AccountAiFeatures | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const loadSeq = useRef(0);
  const writeSeq = useRef(0);
  const activeAccountRef = useRef(resolvedAccountRef);
  activeAccountRef.current = resolvedAccountRef;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const seq = ++loadSeq.current;
    writeSeq.current += 1;
    setFeatures(null);
    setSaving(false);
    setLoading(true);
    setError("");
    setNotice("");

    void requestForAccount<AccountAiFeatures>(resolvedAccountRef, {
      command: "accountAiFeatures",
      action: "get",
    })
      .then((result) => {
        if (
          !active ||
          !mountedRef.current ||
          loadSeq.current !== seq ||
          activeAccountRef.current !== resolvedAccountRef
        ) {
          return;
        }
        if (isValidAccountAiFeatures(result)) {
          setFeatures(result);
        } else {
          setFeatures(null);
          setError("未能读取有效客户头像同步配置，请点击重试。");
        }
      })
      .catch((cause) => {
        if (
          !active ||
          !mountedRef.current ||
          loadSeq.current !== seq ||
          activeAccountRef.current !== resolvedAccountRef
        ) {
          return;
        }
        setFeatures(null);
        setError(explainSafe(cause, "读取客户头像同步设置失败，请重试。"));
      })
      .finally(() => {
        if (
          active &&
          mountedRef.current &&
          loadSeq.current === seq &&
          activeAccountRef.current === resolvedAccountRef
        ) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [resolvedAccountRef, reloadTick]);

  async function handleToggle(checked: boolean) {
    if (disabled || offline || saving || loading || features === null) return;
    const targetRef = resolvedAccountRef;
    const seq = ++writeSeq.current;
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const saved = await requestForAccount<AccountAiFeatures>(targetRef, {
        command: "accountAiFeatures",
        action: "setSyncCustomerAvatars",
        enabled: checked,
      });
      const nextEnabled = isValidAccountAiFeatures(saved) ? saved.syncCustomerAvatars : checked;
      if (!nextEnabled) {
        resetAvatarPreviewCache({ role: "CUSTOMER", accountRef: targetRef });
      }
      if (
        !mountedRef.current ||
        writeSeq.current !== seq ||
        activeAccountRef.current !== targetRef
      ) {
        return;
      }
      setFeatures((current) =>
        isValidAccountAiFeatures(saved)
          ? saved
          : current
            ? { ...current, syncCustomerAvatars: checked }
            : null,
      );
      setNotice(
        nextEnabled
          ? "已开启当前账号「同步采集客户头像」。"
          : "已关闭当前账号「同步采集客户头像」，不再写入客户头像缓存。",
      );
    } catch (cause) {
      if (
        !mountedRef.current ||
        writeSeq.current !== seq ||
        activeAccountRef.current !== targetRef
      ) {
        return;
      }
      setError(explainSafe(cause, "保存客户头像同步设置失败。"));
    } finally {
      if (
        mountedRef.current &&
        writeSeq.current === seq &&
        activeAccountRef.current === targetRef
      ) {
        setSaving(false);
      }
    }
  }

  const badgeVariant =
    features === null ? "secondary" : features.syncCustomerAvatars ? "success" : "secondary";
  const badgeText =
    features === null
      ? loading
        ? "读取中"
        : "未读取"
      : features.syncCustomerAvatars
        ? "已开启"
        : "默认关闭";

  return (
    <CardFrame>
      <CardFrameHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardFrameTitle>客户头像本地缓存开关</CardFrameTitle>
          <Badge variant={badgeVariant} size="sm">
            {badgeText}
          </Badge>
        </div>
        <CardFrameDescription>
          按当前账号独立生效{accountLabel ? `（${accountLabel}）` : ""}；仅用于桌面界面辨识，绝不送入模型或作为发送放行依据
        </CardFrameDescription>
      </CardFrameHeader>
      <Card className="space-y-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-[13.5px] font-semibold text-foreground">同步采集客户头像</div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              开启后，仅在本地私有运行目录缓存客户头像供会话列表与消息详情展示；关闭后立即停止采集与预览。
            </p>
          </div>
          <AutoReplySwitch
            checked={Boolean(features?.syncCustomerAvatars)}
            disabled={disabled || offline || loading || saving || features === null}
            ariaLabel="同步采集客户头像"
            onChange={(checked) => {
              void handleToggle(checked);
            }}
          />
        </div>

        {offline && (
          <p
            className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-1.5 text-xs text-warning-foreground"
            role="status"
          >
            官方通道当前未连接，请先在左侧「管理接入」连接通道后再调整客户头像同步开关。
          </p>
        )}

        {error && (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-1.5 text-xs font-medium text-destructive-foreground"
            role="alert"
          >
            <span>{error}</span>
            {features === null && !loading && (
              <Button
                variant="outline"
                size="xs"
                disabled={disabled}
                onClick={() => setReloadTick((n) => n + 1)}
              >
                重试读取
              </Button>
            )}
          </div>
        )}
        {notice && (
          <p
            className="rounded-lg border border-success/30 bg-success/8 px-3 py-1.5 text-xs font-medium text-success-foreground"
            role="status"
          >
            {notice}
          </p>
        )}
      </Card>
    </CardFrame>
  );
}
