import { digest } from '../../core/contracts.js';
import type { SensitiveGuardConfig } from './types.js';

export type GuardLayer = 'NONE' | 'CUSTOM' | 'PLATFORM_REDLINE' | 'PROMPT_INJECTION';

export interface SensitiveCheckResult {
  blocked: boolean;
  layer: GuardLayer;
  reasonCode:
    | 'SAFETY_CLEAR'
    | 'CUSTOM_SENSITIVE_WORD'
    | 'PLATFORM_REDLINE_WORD'
    | 'PROMPT_INJECTION_DETECTED';
  category?: string;
  ruleId?: string;
  /** 仅记录规则哈希，绝不回传敏感词或客户隐私明文 */
  ruleDigest?: string;
}

interface RedlineRule {
  id: string;
  category: 'off_platform_diversion' | 'private_payment' | 'pii_credential' | 'external_link' | 'prohibited_claim';
  pattern: RegExp;
  /** 为 true 时会对去噪紧凑文本也做匹配，防范“加.微.信”插字符绕过 */
  matchCompact?: boolean;
}

/**
 * 第二层：内置平台导流与合规红线规则（净室编写）。
 * 注意边界：不误伤常规中文/英文业务对话与测试固定词（如 hello、Fixture、video、review）。
 */
const PLATFORM_REDLINE_RULES: readonly RedlineRule[] = [
  {
    id: 'diversion_wechat_explicit',
    category: 'off_platform_diversion',
    pattern: /(?:加|搜|联系|私聊|私信|扫码|扫二维码|发我|给你|留个|留一下).{0,5}(?:微信|微信号|企微|绿泡泡|地球号|v信|威信|卫星号|vx|wx|qq|qq群|微信群)/iu,
    matchCompact: true,
  },
  {
    id: 'diversion_wechat_handle',
    category: 'off_platform_diversion',
    pattern: /(?:^|[^\p{L}\p{N}])(?:微信号|vx号?|wx号?|v信|企微号|qq号?|tg号?|telegram)\s*[:：=]?\s*[a-z0-9_-]{3,}/iu,
  },
  {
    id: 'diversion_plus_v',
    category: 'off_platform_diversion',
    pattern: /(?:\+\s*(?:v|vx|wx|微|qq)|加\s*(?:我\s*)?(?:v|vx|wx|q)\b|站外联系|站外沟通|导流到微信|拉你进微信群)/iu,
  },
  {
    id: 'private_payment_transfer',
    category: 'private_payment',
    pattern: /(?:私下转账|直接转账|线下交易|线下付款|私下付款|转我支付宝|支付宝转账|微信转账|打款到个人|发收款码|扫收款码|直接打款|私下交易)/iu,
    matchCompact: true,
  },
  {
    id: 'pii_credential_or_contact',
    category: 'pii_credential',
    pattern: /(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d{11,19}\b|(?:验证码|银行卡号?|身份证号?|登录密码|支付密码)\s*[:：]?\s*[a-z0-9*]{3,}|(?:验证码|银行卡|身份证|密码|password|verification))/iu,
  },
  {
    id: 'external_url_scheme',
    category: 'external_link',
    pattern: /(?:https?:\/\/|weixin:\/\/|mqqwpa:\/\/|t\.me\/|\bwww\.[a-z0-9-]+\.[a-z]{2,})/iu,
  },
  {
    id: 'prohibited_platform_claims',
    category: 'prohibited_claim',
    pattern: /(?:刷单|代刷|赌博|博彩|外挂|裸聊|色情|包治百病|根治百病|百分百根治|国家级第一|全网最低违法)/iu,
    matchCompact: true,
  },
];

/** 出站额外强约束：防止模型被诱导输出站外导流话术或交易资金敏感词 */
const OUTBOUND_EXTRA_REDLINE_RULES: readonly RedlineRule[] = [
  {
    id: 'outbound_payment_sensitive',
    category: 'private_payment',
    pattern: /(?:转账|金钱|payment|打款|收款码|加微|微信号|vx|wx|qq群|站外)/iu,
  },
];

const PROMPT_INJECTION_RULES: readonly { id: string; pattern: RegExp }[] = [
  {
    id: 'pi_ignore_instructions_en',
    pattern: /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?|prompts?)\b/iu,
  },
  {
    id: 'pi_system_prompt_en',
    pattern: /\b(?:reveal|print|output|show)\s+(?:your\s+)?(?:system\s+prompt|hidden\s+instructions?)\b|\bDAN\s+mode\b/iu,
  },
  {
    id: 'pi_ignore_instructions_zh',
    pattern: /(?:忽略|无视|忘记)(?:之前|以上|前面|所有)(?:的)?(?:所有)?(?:指令|规则|设定|提示词|约束)/iu,
  },
  {
    id: 'pi_reveal_system_zh',
    pattern: /(?:输出|打印|告诉我|泄露)(?:你的)?(?:系统提示词|系统指令|内部规则)|(?:进入越狱模式|扮演不受限制的)/iu,
  },
];

const ZERO_WIDTH_PATTERN = /[\u200b-\u200f\u202a-\u202e\ufeff]/gu;
const NOISE_SEPARATOR_PATTERN = /[\s.\-_*·•~`'"“”‘’|/\\]+/gu;

export function normalizeTextForGuard(text: string): { normalized: string; compact: string } {
  const normalized = text.normalize('NFKC').replace(ZERO_WIDTH_PATTERN, '').trim();
  const compact = normalized.replace(NOISE_SEPARATOR_PATTERN, '');
  return { normalized, compact };
}

function matchCustomWords(
  normalizedLower: string,
  compactLower: string,
  customWords: readonly string[],
): SensitiveCheckResult | null {
  for (const raw of customWords) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const { normalized, compact } = normalizeTextForGuard(trimmed);
    const wordLower = normalized.toLocaleLowerCase();
    const compactWordLower = compact.toLocaleLowerCase();
    if (
      (wordLower.length > 0 && normalizedLower.includes(wordLower)) ||
      (compactWordLower.length >= 2 && compactLower.includes(compactWordLower))
    ) {
      return {
        blocked: true,
        layer: 'CUSTOM',
        reasonCode: 'CUSTOM_SENSITIVE_WORD',
        category: 'custom_word',
        ruleId: 'custom_sensitive_word',
        ruleDigest: digest(wordLower),
      };
    }
  }
  return null;
}

function matchRedlineRules(
  normalized: string,
  compact: string,
  rules: readonly RedlineRule[],
): SensitiveCheckResult | null {
  for (const rule of rules) {
    if (rule.pattern.test(normalized) || (rule.matchCompact && rule.pattern.test(compact))) {
      return {
        blocked: true,
        layer: 'PLATFORM_REDLINE',
        reasonCode: 'PLATFORM_REDLINE_WORD',
        category: rule.category,
        ruleId: rule.id,
        ruleDigest: digest(rule.id),
      };
    }
  }
  return null;
}

function matchPromptInjection(normalized: string): SensitiveCheckResult | null {
  for (const rule of PROMPT_INJECTION_RULES) {
    if (rule.pattern.test(normalized)) {
      return {
        blocked: true,
        layer: 'PROMPT_INJECTION',
        reasonCode: 'PROMPT_INJECTION_DETECTED',
        category: 'prompt_injection',
        ruleId: rule.id,
        ruleDigest: digest(rule.id),
      };
    }
  }
  return null;
}

/**
 * 入站前置安全检查（在预算预占和模型调用之前运行，零额度消耗）：
 * 第一层自定义敏感词 -> 第二层平台导流合规红线（按开关） -> 提示注入检测（按开关）。
 */
export function checkInboundSafety(text: string, config: SensitiveGuardConfig): SensitiveCheckResult {
  const { normalized, compact } = normalizeTextForGuard(text);
  const normalizedLower = normalized.toLocaleLowerCase();
  const compactLower = compact.toLocaleLowerCase();

  const customHit = matchCustomWords(normalizedLower, compactLower, config.customWords);
  if (customHit) return customHit;

  if (config.enablePlatformRedline) {
    const redlineHit = matchRedlineRules(normalized, compact, PLATFORM_REDLINE_RULES);
    if (redlineHit) return redlineHit;
  }

  if (config.enablePromptInjectionGuard !== false) {
    const injectionHit = matchPromptInjection(normalized);
    if (injectionHit) return injectionHit;
  }

  return { blocked: false, layer: 'NONE', reasonCode: 'SAFETY_CLEAR' };
}

/**
 * 出站二次终审：阻止模型输出违规导流话术、隐私信息或命中自定义敏感词。
 */
export function checkOutboundSafety(text: string, config: SensitiveGuardConfig): SensitiveCheckResult {
  const { normalized, compact } = normalizeTextForGuard(text);
  const normalizedLower = normalized.toLocaleLowerCase();
  const compactLower = compact.toLocaleLowerCase();

  const customHit = matchCustomWords(normalizedLower, compactLower, config.customWords);
  if (customHit) return customHit;

  if (config.enablePlatformRedline) {
    const redlineHit = matchRedlineRules(normalized, compact, PLATFORM_REDLINE_RULES);
    if (redlineHit) return redlineHit;

    const outboundExtraHit = matchRedlineRules(normalized, compact, OUTBOUND_EXTRA_REDLINE_RULES);
    if (outboundExtraHit) return outboundExtraHit;
  }

  return { blocked: false, layer: 'NONE', reasonCode: 'SAFETY_CLEAR' };
}
