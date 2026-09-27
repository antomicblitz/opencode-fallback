import type { HookDeps } from "./types"
import { logInfo } from "./logger"
import { waitForChildFallbackResult, type WaitOptions } from "./subagent-result-sync"

/**
 * Reconciles a "Task cancelled" task-tool result that was produced by a
 * plugin-initiated child-session abort.
 *
 * OpenCode's task tool runs each subagent as a BackgroundJob whose id is the
 * child session id, with `metadata.parentSessionId` pointing at the parent
 * (packages/opencode/src/tool/task.ts).  Aborting the child session therefore
 * cancels the task's own background job, and the parent's task tool returns
 * `"Task cancelled"` to the model — even though the fallback plugin then
 * replays the child on the fallback model and the subagent keeps working.
 *
 * The plugin records every child it aborts on a fallback path in
 * `sessionRecoveryCandidates`.  This module runs in OpenCode's
 * `experimental.chat.messages.transform` hook, i.e. just before the parent's
 * model request that would carry the false cancellation.  It waits for the
 * child to produce its real result and rewrites the cancelled task part into a
 * completed one, so the parent reasons on the subagent's output instead of a
 * premature "Task cancelled".
 */

/** Matches the task tool's background-job cancellation error. */
const TASK_CANCELLED_PATTERN = /task\s+cancel?led/i

type PartState = {
	status?: string
	error?: unknown
	input?: unknown
	title?: string
	metadata?: Record<string, unknown>
	output?: string
	time?: { start?: number; end?: number } & Record<string, unknown>
	[key: string]: unknown
}

export interface TransformerPart {
	id?: string
	type?: string
	tool?: string
	callID?: string
	state?: PartState
	[key: string]: unknown
}

export interface TransformerMessage {
	info?: { id?: string; role?: string } & Record<string, unknown>
	parts?: TransformerPart[]
}

/** True when a part is a task tool call that OpenCode reported as cancelled. */
export function isCancelledTaskPart(part: TransformerPart | undefined): boolean {
	if (!part || part.type !== "tool" || part.tool !== "task") return false
	const error = part.state?.error
	return (
		part.state?.status === "error" &&
		typeof error === "string" &&
		TASK_CANCELLED_PATTERN.test(error)
	)
}

/** Extracts the child session id the task tool stored in the part metadata. */
export function childSessionIDFromTaskPart(
	part: TransformerPart | undefined,
): string | undefined {
	const id = part?.state?.metadata?.sessionId
	return typeof id === "string" && id.startsWith("ses_") ? id : undefined
}

/** Rewrites a cancelled task part into a completed one carrying `output`. */
export function markTaskPartCompleted(
	part: TransformerPart,
	output: string,
	now: number,
): void {
	const state = part.state ?? {}
	part.state = {
		...state,
		status: "completed",
		input: state.input,
		title:
			typeof state.title === "string" && state.title.length > 0
				? state.title
				: "task",
		metadata: { ...(state.metadata ?? {}), recoveredByPlugin: true },
		output,
		time: {
			start: state.time?.start ?? now,
			end: now,
		},
	}
}

/**
 * Scans model messages for cancelled task parts whose child session the plugin
 * aborted for a fallback, waits (bounded) for the child's real result, and
 * rewrites those parts in place.
 *
 * Returns the number of parts rewritten.
 */
export async function recoverCancelledTaskParts(
	deps: HookDeps,
	messages: TransformerMessage[] | undefined,
	options?: WaitOptions,
): Promise<number> {
	if (
		!messages ||
		messages.length === 0 ||
		deps.sessionRecoveryCandidates.size === 0
	) {
		return 0
	}

	let recovered = 0
	for (const message of messages) {
		if (!message.parts) continue
		for (const part of message.parts) {
			if (!isCancelledTaskPart(part)) continue

			const childSessionID = childSessionIDFromTaskPart(part)
			if (!childSessionID) continue

			const candidate = deps.sessionRecoveryCandidates.get(childSessionID)
			if (!candidate) continue

			let result = candidate.recoveredResult
			if (!result) {
				// Another transform may already have claimed this candidate and
				// be waiting for the same child; don't duplicate the wait.
				if (candidate.recoveredResult === "") continue
				candidate.recoveredResult = ""

				const waited = await waitForChildFallbackResult(deps, childSessionID, {
					...options,
					sinceTimestamp: candidate.abortedAt,
				})

				if (!waited) {
					// No result: the child did not recover.  Drop the candidate so
					// the original cancellation stands and we do not re-poll it on
					// every later request.
					deps.sessionRecoveryCandidates.delete(childSessionID)
					logInfo(
						"Cancelled task recovery: no child result, preserving cancellation",
						{ childSessionID },
					)
					continue
				}

				result = waited
				candidate.recoveredResult = result
				logInfo("Cancelled task recovery: substituting child result", {
					childSessionID,
					responseLength: result.length,
				})
			}

			markTaskPartCompleted(part, result, Date.now())
			recovered++
		}
	}

	return recovered
}
