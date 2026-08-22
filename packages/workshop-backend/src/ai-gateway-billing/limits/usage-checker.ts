// Usage checker: combines the daily free-tier counter with the BYOK/balance logic to decide
// whether a user's request may proceed, and whose credentials to use.
//
//   - Connected + balance >= minimum -> billed to the user's own gateway, no daily cap; the daily
//     counter is NOT consumed (the platform free tier is reserved for everyone else).
//   - Connected + balance below minimum (incl. $0), or not connected -> platform free tier; the
//     daily counter is consumed and, once exhausted, the request is blocked.

import { CloudflareUsageInfo } from "@gadgets/workshop-shared/api";
import { isCloudflareLimitsEnabled, getMinWalletBalance, getMinimumCloudflareBalance } from "../config.js";
import { LimitWindowKind } from "@gadgets/workshop-shared/limits";
import { getDailyLlmCallLimit } from "./config.js";
import { getConnectionStatus, resolveConnection, ByokGatewayRouting } from "../cloudflare/connection-service.js";
import type { UserDurableObject } from "../../user.js";

export interface UsageCheckResult {
  // Whether the request may proceed.
  allowed: boolean;
  // Guidance/reason when blocked.
  reason?: string;
  // Whether to serve the request using the user's own gateway/keys rather than the platform's.
  shouldUseByok: boolean;
  // Whether the user is within their free-tier limit.
  withinLimits: boolean;
  // Calls remaining in the current window (Infinity when limits are disabled).
  remaining: number;
  // The configured limit (Infinity when limits are disabled).
  limit: number;
  // Window kind and reset time (omitted when unlimited).
  windowKind?: LimitWindowKind;
  resetAt?: string;
  // The user's Cloudflare AI Gateway balance, or null if unknown / not connected.
  balance: number | null;
  // Whether the user has connected a Cloudflare account with a usable token.
  hasUserToken: boolean;
  // Routing to bill the user's own account, present only when shouldUseByok is true. Resolved here
  // (reusing the connection lookup) so the caller needn't decrypt the token a second time.
  byokRouting?: ByokGatewayRouting;
}

// Result used when limits are disabled (self-hosted / unlimited).
function unlimitedResult(): UsageCheckResult {
  return {
    allowed: true,
    shouldUseByok: false,
    withinLimits: true,
    remaining: Infinity,
    limit: Infinity,
    balance: null,
    hasUserToken: false,
  };
}

// Check whether the user may proceed with an LLM-backed request.
//
// When limits are disabled, always allows without touching the user object. Otherwise: connected +
// funded users bill their own gateway and skip the daily counter entirely; everyone else draws on
// the platform free tier (consuming one call against the user object) until it's exhausted.
export async function checkUsageAndBalance(
  env: Cloudflare.Env,
  userStub: DurableObjectStub<UserDurableObject>,
): Promise<UsageCheckResult> {
  if (!isCloudflareLimitsEnabled(env)) {
    return unlimitedResult();
  }

  const aiPreference = await userStub.getAiPreference();

  let hasUserToken = false;
  let balance: number | null = null;
  let byokRouting: ByokGatewayRouting | undefined;
  const conn = await resolveConnection(env, userStub);
  hasUserToken = conn.status.connected;
  balance = conn.status.balance;
  if (conn.accessToken && conn.accountId) {
    byokRouting = { accountId: conn.accountId, apiKey: conn.accessToken };
  }

  if (aiPreference === "custom") {
    // A funded Cloudflare connection lets Custom AI route through the user's own AI Gateway for
    // unified BYOK billing (all providers). Without one, the user's own provider API keys are used
    // directly; we still allow the turn and do not charge the wallet.
    if (hasUserToken && balance !== null && balance >= getMinimumCloudflareBalance(env)) {
      return {
        allowed: true,
        shouldUseByok: true,
        withinLimits: true,
        remaining: Infinity,
        limit: Infinity,
        windowKind: "daily",
        resetAt: new Date(Date.now() + 86400 * 1000).toISOString(),
        balance,
        hasUserToken,
        byokRouting,
      };
    }

    return {
      allowed: true,
      shouldUseByok: false,
      withinLimits: true,
      remaining: Infinity,
      limit: Infinity,
      balance,
      hasUserToken,
    };
  }

  // System AI uses the wallet (held in USD) as the single meter. We only *check* the balance here;
  // the actual cost of each LLM call is deducted after it completes (see Overseer.addChatMessages),
  // so failed turns are never charged and cheap/expensive models are billed accurately.
  const walletBalance = await userStub.getWalletBalance();
  const minBalance = getMinWalletBalance(env);
  if (walletBalance <= minBalance) {
    return {
      allowed: false,
      reason: "Wallet balance is too low for System AI. Recharge your wallet or switch to Custom AI (BYOK).",
      shouldUseByok: false,
      withinLimits: false,
      remaining: Math.max(0, walletBalance),
      limit: Infinity,
      windowKind: "daily",
      resetAt: new Date(Date.now() + 86400 * 1000).toISOString(),
      balance,
      hasUserToken,
    };
  }

  // Within wallet budget: the turn may proceed; the per-call cost is charged as it is incurred.
  return {
    allowed: true,
    shouldUseByok: false,
    withinLimits: true,
    remaining: walletBalance,
    limit: Infinity,
    windowKind: "daily",
    resetAt: new Date(Date.now() + 86400 * 1000).toISOString(),
    balance,
    hasUserToken,
  };
}

export async function getUsageInfo(
  env: Cloudflare.Env,
  userStub: DurableObjectStub<UserDurableObject>,
): Promise<CloudflareUsageInfo> {
  if (!isCloudflareLimitsEnabled(env)) {
    return {
      cloudflareLimitsEnabled: false,
      unlimited: true,
      dailyUsed: 0,
      dailyLimit: 0,
      remaining: 0,
      connected: false,
      balance: null,
    };
  }

  const limit = getDailyLlmCallLimit(env);
  // These two reads are independent — run them together to halve latency on this UI polling path.
  const [quota, status] = await Promise.all([
    userStub.checkDailyLlmCount(limit),
    getConnectionStatus(env, userStub),
  ]);

  return {
    cloudflareLimitsEnabled: true,
    unlimited: false,
    dailyUsed: quota.used,
    dailyLimit: quota.limit,
    remaining: quota.remaining,
    resetAt: quota.resetAt,
    connected: status.connected,
    balance: status.balance,
    accountId: status.accountId,
    accountName: status.accountName,
    needsAccountSelection: status.needsAccountSelection,
  };
}
