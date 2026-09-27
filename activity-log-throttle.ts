// Streaming emits one activity event per token, and the fallback timeout used
// to log a reset line for every one of them: ~200 identical lines in two
// seconds, inside a 2.5 MB log, which buried the entries that matter (a real
// replay cycle could not be read without filtering).
//
// Throttle the line to one per window per session and report how many were
// suppressed, so the log stays honest and readable.

const WINDOW_MS = 10_000
const MAX_SESSIONS = 512

const lastLogAt = new Map<string, number>()
const suppressedSinceLast = new Map<string, number>()

function prune(): void {
	if (lastLogAt.size <= MAX_SESSIONS) return
	const oldest = lastLogAt.keys().next().value
	if (oldest !== undefined) {
		lastLogAt.delete(oldest)
		suppressedSinceLast.delete(oldest)
	}
}

export interface ActivityLogDecision {
	log: boolean
	/** Activity events seen since the last emitted line (0 when logging). */
	suppressed: number
}

export function shouldLogActivity(
	sessionID: string,
	now: number = Date.now(),
): ActivityLogDecision {
	const last = lastLogAt.get(sessionID)
	if (last === undefined || now - last >= WINDOW_MS) {
		const suppressed = suppressedSinceLast.get(sessionID) ?? 0
		lastLogAt.set(sessionID, now)
		suppressedSinceLast.set(sessionID, 0)
		prune()
		return { log: true, suppressed }
	}
	suppressedSinceLast.set(sessionID, (suppressedSinceLast.get(sessionID) ?? 0) + 1)
	prune()
	return { log: false, suppressed: 0 }
}

/** Test helper: drop the throttle state between cases. */
export function resetActivityLogThrottle(): void {
	lastLogAt.clear()
	suppressedSinceLast.clear()
}
