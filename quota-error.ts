import { getErrorMessage } from "./error-classifier"

/**
 * Payment/quota/credit failures do not heal in seconds. A model that failed
 * because the account is out of quota must not be retried on the transient
 * cooldown (default 60s) — each premature flip back re-primes the whole
 * prompt on a different provider (cache forfeit) and typically fails again
 * the same way. Quota failures get their own, much longer cooldown via
 * `quota_cooldown_seconds`.
 */
const QUOTA_ERROR_PATTERNS = [
	/payment\s+required/i,
	/insufficient.?(?:credits?|funds?|balance)/i,
	/credit.*balance.*too.*low/i,
	/credit\s+balance/i,
	/quota.*(?:exceeded|limit|reached)/i,
	/(?:exceeded|reached).*(?:quota|usage\s+limit)/i,
	/usage\s+limit\s+has\s+been\s+reached/i,
	/\b402\b/,
	/\bbilling\b/i,
]

export function isQuotaError(error: unknown): boolean {
	const message = getErrorMessage(error)
	if (!message) return false
	return QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}
