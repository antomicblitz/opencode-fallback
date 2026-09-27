import { describe, expect, it, mock, beforeEach } from "bun:test"
import {
	isCancelledTaskPart,
	childSessionIDFromTaskPart,
	markTaskPartCompleted,
	recoverCancelledTaskParts,
	type TransformerMessage,
	type TransformerPart,
} from "./cancelled-task-recovery"
import type { HookDeps, PluginContext } from "./types"

function createMockDeps(overrides?: {
	messagesData?: Array<{
		info?: Record<string, unknown>
		parts?: Array<{ type?: string; text?: string }>
	}>
	getData?: Record<string, unknown>
}): HookDeps {
	const messagesData = overrides?.messagesData ?? []
	const ctx: PluginContext = {
		directory: "/test/dir",
		client: {
			session: {
				abort: mock(() => Promise.resolve()),
				messages: mock(() => Promise.resolve({ data: messagesData })),
				promptAsync: mock(() => Promise.resolve()),
				get: mock(() =>
					Promise.resolve({ data: overrides?.getData ?? { status: "idle" } })
				),
			},
			tui: {
				showToast: mock(() => Promise.resolve()),
			},
		},
	}

	return {
		ctx,
		config: {
			enabled: true,
			retry_on_errors: [429, 500, 503],
			retryable_error_patterns: [],
			max_fallback_attempts: 3,
			cooldown_seconds: 60,
			timeout_seconds: 120,
			notify_on_fallback: true,
			fallback_models: [],
		},
		agentConfigs: undefined,
		globalFallbackModels: [],
		sessionStates: new Map(),
		sessionLastAccess: new Map(),
		sessionRetryInFlight: new Set(),
		sessionAwaitingFallbackResult: new Set(),
		sessionFallbackTimeouts: new Map(),
		sessionFirstTokenReceived: new Map(),
		sessionSelfAbortTimestamp: new Map(),
		sessionParentID: new Map(),
		sessionIdleResolvers: new Map(),
		sessionLastMessageTime: new Map(),
		sessionCompactionInFlight: new Set(),
		sessionRecoveryCandidates: new Map(),
	}
}

function cancelledTaskPart(childSessionID: string, error = "Task cancelled"): TransformerPart {
	return {
		id: "prt_task_1",
		type: "tool",
		tool: "task",
		callID: "call_1",
		state: {
			status: "error",
			error,
			input: { description: "child work" },
			title: "child work",
			metadata: { sessionId: childSessionID },
			time: { start: 1000, end: 2000 },
		},
	}
}

function parentMessage(part: TransformerPart): TransformerMessage {
	return {
		info: { id: "msg_assistant_1", role: "assistant" },
		parts: [part],
	}
}

describe("cancelled-task-recovery", () => {
	describe("isCancelledTaskPart", () => {
		it("returns true for a task part in error with 'Task cancelled'", () => {
			expect(isCancelledTaskPart(cancelledTaskPart("ses_child1"))).toBe(true)
		})

		it("is case-insensitive and accepts the single-l spelling", () => {
			expect(isCancelledTaskPart(cancelledTaskPart("ses_child1", "task canceled"))).toBe(true)
		})

		it("returns false for a non-task tool", () => {
			const part = cancelledTaskPart("ses_child1")
			part.tool = "bash"
			expect(isCancelledTaskPart(part)).toBe(false)
		})

		it("returns false for a completed task part", () => {
			const part = cancelledTaskPart("ses_child1")
			part.state!.status = "completed"
			expect(isCancelledTaskPart(part)).toBe(false)
		})

		it("returns false for an unrelated task error", () => {
			expect(
				isCancelledTaskPart(cancelledTaskPart("ses_child1", "Subagent failed: boom"))
			).toBe(false)
		})

		it("returns false for undefined", () => {
			expect(isCancelledTaskPart(undefined)).toBe(false)
		})
	})

	describe("childSessionIDFromTaskPart", () => {
		it("extracts a ses_* id from state metadata", () => {
			expect(childSessionIDFromTaskPart(cancelledTaskPart("ses_abc123"))).toBe("ses_abc123")
		})

		it("returns undefined when metadata is missing", () => {
			const part = cancelledTaskPart("ses_abc123")
			part.state!.metadata = {}
			expect(childSessionIDFromTaskPart(part)).toBeUndefined()
		})

		it("returns undefined for a non-session value", () => {
			const part = cancelledTaskPart("ses_abc123")
			part.state!.metadata = { sessionId: "not-a-session" }
			expect(childSessionIDFromTaskPart(part)).toBeUndefined()
		})
	})

	describe("markTaskPartCompleted", () => {
		it("rewrites the error state into a completed state", () => {
			const part = cancelledTaskPart("ses_child1")
			markTaskPartCompleted(part, "real child result", 5000)

			expect(part.state!.status).toBe("completed")
			expect(part.state!.output).toBe("real child result")
			expect(part.state!.input).toEqual({ description: "child work" })
			expect(part.state!.title).toBe("child work")
			expect(part.state!.metadata!.sessionId).toBe("ses_child1")
			expect(part.state!.metadata!.recoveredByPlugin).toBe(true)
			expect(part.state!.time).toEqual({ start: 1000, end: 5000 })
		})

		it("falls back to a generic title and now for a missing start", () => {
			const part: TransformerPart = {
				type: "tool",
				tool: "task",
				state: { status: "error", error: "Task cancelled", metadata: { sessionId: "ses_x" } },
			}
			markTaskPartCompleted(part, "result", 7000)
			expect(part.state!.title).toBe("task")
			expect(part.state!.time).toEqual({ start: 7000, end: 7000 })
		})
	})

	describe("recoverCancelledTaskParts", () => {
		let deps: HookDeps

		beforeEach(() => {
			deps = createMockDeps()
		})

		it("does nothing when there are no recovery candidates", async () => {
			const messages = [parentMessage(cancelledTaskPart("ses_child1"))]
			const count = await recoverCancelledTaskParts(deps, messages)

			expect(count).toBe(0)
			expect(messages[0].parts![0].state!.status).toBe("error")
			expect(deps.ctx.client.session.messages).not.toHaveBeenCalled()
		})

		it("replaces a cancelled task with the child's result", async () => {
			deps = createMockDeps({
				getData: { status: "idle" },
				messagesData: [
					{ info: { role: "user" }, parts: [{ type: "text", text: "do it" }] },
					{
						info: { role: "assistant", time: { created: 3000 } },
						parts: [{ type: "text", text: "fallback child result" }],
					},
				],
			})
			deps.sessionRecoveryCandidates.set("ses_child1", { abortedAt: 2500 })

			const messages = [parentMessage(cancelledTaskPart("ses_child1"))]
			const count = await recoverCancelledTaskParts(deps, messages)

			expect(count).toBe(1)
			expect(messages[0].parts![0].state!.status).toBe("completed")
			expect(messages[0].parts![0].state!.output).toBe("fallback child result")
			// Result is cached for later requests.
			expect(deps.sessionRecoveryCandidates.get("ses_child1")!.recoveredResult).toBe(
				"fallback child result"
			)
		})

		it("reuses the cached result without re-polling the child", async () => {
			deps = createMockDeps()
			deps.sessionRecoveryCandidates.set("ses_child1", {
				abortedAt: 2500,
				recoveredResult: "cached result",
			})

			const messages = [parentMessage(cancelledTaskPart("ses_child1"))]
			await recoverCancelledTaskParts(deps, messages)

			expect(messages[0].parts![0].state!.output).toBe("cached result")
			expect(deps.ctx.client.session.messages).not.toHaveBeenCalled()
		})

		it("rejects a stale pre-abort assistant message", async () => {
			deps = createMockDeps({
				getData: { status: "idle" },
				messagesData: [
					{
						info: { role: "assistant", time: { created: 1000 } },
						parts: [{ type: "text", text: "stale partial output" }],
					},
				],
			})
			deps.sessionRecoveryCandidates.set("ses_child1", { abortedAt: 2500 })

			const messages = [parentMessage(cancelledTaskPart("ses_child1"))]
			const count = await recoverCancelledTaskParts(deps, messages, { maxWaitMs: 50 })

			expect(count).toBe(0)
			expect(messages[0].parts![0].state!.status).toBe("error")
			expect(deps.sessionRecoveryCandidates.has("ses_child1")).toBe(false)
		})

		it("leaves a genuine cancellation without a candidate untouched", async () => {
			deps = createMockDeps({
				getData: { status: "idle" },
				messagesData: [
					{
						info: { role: "assistant", time: { created: 3000 } },
						parts: [{ type: "text", text: "child output" }],
					},
				],
			})

			const messages = [parentMessage(cancelledTaskPart("ses_child1"))]
			const count = await recoverCancelledTaskParts(deps, messages)

			expect(count).toBe(0)
			expect(messages[0].parts![0].state!.status).toBe("error")
			expect(deps.ctx.client.session.messages).not.toHaveBeenCalled()
		})

		it("handles undefined messages", async () => {
			expect(await recoverCancelledTaskParts(deps, undefined)).toBe(0)
		})
	})
})
