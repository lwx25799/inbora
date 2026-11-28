import { useEffect, useState } from "react";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { useAvatarPreview, type AvatarRole } from "@/useAvatarPreview";

const AVATAR_TONES = [
  "bg-[#e6efe9] text-[#174f43] dark:bg-[#1e3630] dark:text-[#8fd9c9]",
  "bg-[#f3eae0] text-[#7c4b1e] dark:bg-[#382b1e] dark:text-[#e8bf8c]",
  "bg-[#e7ecf4] text-[#284c78] dark:bg-[#202d3d] dark:text-[#98c1f0]",
  "bg-[#f2e7e7] text-[#7d3330] dark:bg-[#382222] dark:text-[#eba29e]",
  "bg-[#ecebe4] text-[#4c4d3a] dark:bg-[#2c2d25] dark:text-[#cbcbb6]",
] as const;

export function avatarTone(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length]!;
}

export function avatarInitial(name: string | null | undefined, fallback = "客"): string {
  const trimmed = (name ?? "").trim();
  return trimmed ? [...trimmed][0]! : fallback;
}

export function resolveCustomerTargetKey(payload: {
  channel: string;
  conversationId?: string | null;
  videoId?: string | null;
  commentId?: string | null;
}): string {
  return payload.channel === "DIRECT_MESSAGE"
    ? `dm:${payload.conversationId ?? "?"}`
    : `comment:${payload.videoId ?? "?"}:${payload.commentId ?? "?"}`;
}

export function resolveCustomerAvatarKey(source: {
  actorId?: string | null;
  targetKey?: string | null;
  avatarKey?: string | null;
  payload?: {
    actorId?: string | null;
    channel: string;
    conversationId?: string | null;
    videoId?: string | null;
    commentId?: string | null;
  };
  groupKey?: string | null;
  id?: string | null;
}): string | null {
  if (source.avatarKey?.trim()) return source.avatarKey.trim();
  if (source.payload) {
    return (
      source.payload.actorId ??
      source.targetKey ??
      resolveCustomerTargetKey(source.payload)
    );
  }
  return source.actorId ?? source.targetKey ?? source.groupKey ?? source.id ?? null;
}

export interface CachedAvatarProps {
  role: AvatarRole;
  avatarKey: string | null | undefined;
  accountRef?: string | null;
  fallbackText: string;
  alt?: string;
  className?: string;
  fallbackClassName?: string;
  ariaHidden?: boolean;
}

export function CachedAvatar({
  role,
  avatarKey,
  accountRef,
  fallbackText,
  alt = "",
  className,
  fallbackClassName,
  ariaHidden = true,
}: CachedAvatarProps): React.ReactElement {
  const dataUrl = useAvatarPreview(role, avatarKey, accountRef);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  useEffect(() => {
    setFailedUrl(null);
  }, [dataUrl]);

  const showImage = Boolean(dataUrl && failedUrl !== dataUrl);

  return (
    <span
      aria-hidden={ariaHidden || undefined}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden select-none",
        showImage ? "bg-muted" : fallbackClassName,
        className,
      )}
    >
      {showImage ? (
        <img
          src={dataUrl!}
          alt={alt}
          className="size-full object-cover"
          onError={() => setFailedUrl(dataUrl)}
        />
      ) : (
        fallbackText
      )}
    </span>
  );
}
