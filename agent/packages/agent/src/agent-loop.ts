/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@mariozechner/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

// ---------------------------------------------------------------------------
// Coverage tracking helpers — port of king's 3 runtime mechanisms
// ---------------------------------------------------------------------------

/** Extract candidate file paths from the DISCOVERY section of the system prompt */
function parseExpectedFiles(systemPrompt: string): string[] {
	const files: string[] = [];
	const discoveryBlock = systemPrompt.match(
		/(?:FILES EXPLICITLY NAMED|FILES MATCHING BY NAME|FILES CONTAINING|LIKELY RELEVANT FILES)[^\n]*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|\n(?=##)|$)/gi,
	);
	if (discoveryBlock) {
		for (const block of discoveryBlock) {
			const lines = block.split("\n");
			for (const line of lines) {
				const m = line.match(/^-\s+(\S+\.\w{1,6})/);
				if (m) files.push(m[1]);
			}
		}
	}
	const named = systemPrompt.match(/Files named in the task text:\s*(.*)/i);
	if (named) {
		const ticks = named[1].match(/`([^`]+)`/g);
		if (ticks) {
			for (const t of ticks) files.push(t.replace(/`/g, ""));
		}
	}
	return [...new Set(files)];
}

function parseExpectedCriteriaCount(systemPrompt: string): number {
	const m = systemPrompt.match(/This task has (\d+) acceptance criteria/i);
	return m ? parseInt(m[1], 10) : 0;
}

function trackFileEdit(toolName: string, args: Record<string, any>, editedFiles: Set<string>): void {
	const editToolNames = new Set(["edit", "write", "str_replace_editor", "str_replace_based_edit_tool"]);
	if (editToolNames.has(toolName)) {
		const filePath = args?.path || args?.file || args?.filePath;
		if (typeof filePath === "string" && filePath.length > 0) {
			editedFiles.add(filePath.replace(/^\.\//, ""));
		}
	}
}

function buildInjectionMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// --- Tracking state ---
	const editedFiles = new Set<string>();
	let hasProducedEdit = false;
	let coverageNudgeFired = false;
	let lastCriteriaInjectionCount = 0;
	let totalToolCalls = 0;
	let totalTurns = 0;
	let forcedWriteAttempts = 0;
	const MAX_FORCED_WRITE_ATTEMPTS = 2;
	const expectedFiles = parseExpectedFiles(currentContext.systemPrompt);
	const expectedCriteriaCount = parseExpectedCriteriaCount(currentContext.systemPrompt);
	let lastEditedPath: string | null = null;
	let siblingNudgeFired = 0;
	let editFailedAndReread = false;
	let prevEditCount = 0;

	// --- Fix 6: Multi-file task pre-loop injection ---
	if (expectedCriteriaCount >= 4) {
		const multiFileMsg = buildInjectionMessage(
			`MULTI-FILE TASK: ${expectedCriteriaCount} acceptance criteria detected. You MUST edit at least ${expectedCriteriaCount} files. Start immediately — read file 1, edit it, then file 2, etc.`,
		);
		pendingMessages.push(multiFileMsg);
	}

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				// If error and no edits produced, don't just die — break to outer loop rescue
				if (!hasProducedEdit) {
					hasMoreToolCalls = false;
					break;
				}
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				toolResults.push(...(await executeToolCalls(currentContext, message, config, signal, emit)));

				// --- Track file edits from tool calls ---
				prevEditCount = editedFiles.size;
				for (const tc of toolCalls) {
					trackFileEdit(tc.name, tc.arguments as Record<string, any>, editedFiles);
					// Track lastEditedPath for sibling scan
					const editToolNames = new Set(["edit", "write", "str_replace_editor", "str_replace_based_edit_tool"]);
					if (editToolNames.has(tc.name)) {
						const args = tc.arguments as Record<string, any>;
						const fp = args?.path || args?.file || args?.filePath;
						if (typeof fp === "string" && fp.length > 0) lastEditedPath = fp;
					}
				}
				if (editedFiles.size > 0) hasProducedEdit = true;
				totalToolCalls += toolCalls.length;

				// --- Fix 2: editFailedAndReread double-inject ---
				// If we flagged editFailedAndReread on prev turn and model still didn't edit
				if (editFailedAndReread && editedFiles.size === prevEditCount) {
					// Check if model just did a read (not an edit) — force edit
					const didEdit = toolCalls.some(tc => {
						const eTN = new Set(["edit", "write", "str_replace_editor", "str_replace_based_edit_tool"]);
						return eTN.has(tc.name);
					});
					if (!didEdit) {
						pendingMessages.push(buildInjectionMessage(
							"You re-read the file after a failed edit. Now you MUST use the edit tool with a DIFFERENT oldText anchor. This is mandatory. Do NOT read again. Do NOT stop. EDIT NOW.",
						));
					}
					editFailedAndReread = false;
				} else {
					editFailedAndReread = false;
				}

				// --- Fix 3: Edit failure recovery — inject retry after failed edit ---
				const editLikeTools = new Set(["edit", "write", "str_replace_editor", "str_replace_based_edit_tool"]);
				for (const tc of toolCalls) {
					if (editLikeTools.has(tc.name)) {
						const matchingResult = toolResults.find(r => r.toolCallId === tc.id);
						if (matchingResult?.isError) {
							const args = tc.arguments as Record<string, any>;
							const failedPath = args?.path || args?.file || args?.filePath || "the file";
							editFailedAndReread = true;
							pendingMessages.push(buildInjectionMessage(
								`Edit failed on ${failedPath}. REQUIRED: (1) read(${failedPath}) to get current content, then (2) retry edit with a DIFFERENT oldText anchor. Do NOT stop — a failed edit is not a finish. After re-reading, your VERY NEXT call MUST be edit.`,
							));
						}
					}
				}

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}

			}

			totalTurns++;

			await emit({ type: "turn_end", message, toolResults });

			// --- Edit-attempt guard + minimum turn guard (Fix 2) ---
			if (!hasMoreToolCalls && !hasProducedEdit) {
				if (totalToolCalls >= 3) {
					// 3+ tool calls with zero edits — FORCE edit immediately
					const forceMsg = buildInjectionMessage(
						`CRITICAL: ${totalToolCalls} tool calls with ZERO edits. You MUST use edit or write RIGHT NOW. Pick the most relevant file from your reads and apply the change. Do not read again.`,
					);
					pendingMessages.push(forceMsg);
				} else if (totalTurns < 3) {
					// Too early to quit without edits
					const forceMsg = buildInjectionMessage(
						"STOP. You have made ZERO edits and are trying to quit too early. " +
						"You MUST use the edit or write tool NOW. Pick the most relevant file from the task " +
						"and make the required change. A wrong edit scores higher than no edit. DO IT NOW.",
					);
					pendingMessages.push(forceMsg);
				}
			}

			// --- Mechanism 2: Coverage nudge (after edits, check unedited candidate files) ---
			if (hasProducedEdit && !coverageNudgeFired && expectedFiles.length > 0) {
				const uneditedCandidates = expectedFiles.filter((f) => {
					for (const ef of editedFiles) {
						if (ef === f || ef.endsWith("/" + f) || f.endsWith("/" + ef)) return false;
					}
					return true;
				});
				if (uneditedCandidates.length > 0 && uneditedCandidates.length < expectedFiles.length) {
					coverageNudgeFired = true;
					const nudge = buildInjectionMessage(
						`DO NOT STOP yet. Unedited candidate files from discovery: ${uneditedCandidates.join(", ")}. Check if they need changes for the acceptance criteria.`,
					);
					pendingMessages.push(nudge);
				}
			}

			// --- Mechanism 3: Criteria continuation — fires after every new file edit ---
			if (hasProducedEdit && editedFiles.size > lastCriteriaInjectionCount) {
				lastCriteriaInjectionCount = editedFiles.size;
				const isEarlyStop = totalToolCalls < 6;
				const needsMore = editedFiles.size < expectedCriteriaCount || totalToolCalls < 8;
				if (needsMore || isEarlyStop) {
					const urgency = isEarlyStop
						? `DO NOT STOP. Only ${totalToolCalls} tool calls made — MINIMUM IS 6. You MUST make at least ${6 - totalToolCalls} more edits RIGHT NOW.`
						: `Edited ${editedFiles.size} file(s). Continue — check siblings.`;
					const guardrail = buildInjectionMessage(
						`${urgency} Edited so far: ${[...editedFiles].join(", ")}. Run \`ls $(dirname ${lastEditedPath || "last_edited_file"})/\` then edit the next file. Stopping after ${editedFiles.size} file(s) = guaranteed loss.`,
					);
					pendingMessages.push(guardrail);
				}
			}

			// --- Fix 5: Sibling-scan auto-inject after every successful edit ---
			if (hasProducedEdit && lastEditedPath && editedFiles.size > prevEditCount && siblingNudgeFired < 3) {
				siblingNudgeFired++;
				const siblingMsg = buildInjectionMessage(
					`Edited ${lastEditedPath}. Now run: ls $(dirname ${lastEditedPath})/ — find siblings with same pattern and edit them too.`,
				);
				pendingMessages.push(siblingMsg);
			}

			pendingMessages.push(...((await config.getSteeringMessages?.()) || []));
		}

		// --- Forced-write rescue (model stopped with 0 edits, totalToolCalls < 8) ---
		if (!hasProducedEdit && forcedWriteAttempts < MAX_FORCED_WRITE_ATTEMPTS && totalToolCalls < 8) {
			forcedWriteAttempts++;
			const rescue = buildInjectionMessage(
				`FORCED WRITE MODE (attempt ${forcedWriteAttempts}/${MAX_FORCED_WRITE_ATTEMPTS}): ` +
				"You MUST use the edit or write tool on your VERY NEXT tool call. " +
				"Pick the highest-priority file from the task and apply the change NOW. " +
				"Do NOT read, do NOT bash, do NOT grep. EDIT NOW. " +
				"An incorrect edit scores higher than zero edits. WRITE SOMETHING.",
			);
			pendingMessages = [rescue];
			continue;
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	if (config.toolExecution === "sequential") {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			results.push(
				await finalizeExecutedToolCall(
					currentContext,
					assistantMessage,
					preparation,
					executed,
					config,
					signal,
					emit,
				),
			);
		}
	}

	return results;
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	const runnableCalls: PreparedToolCall[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			runnableCalls.push(preparation);
		}
	}

	const runningCalls = runnableCalls.map((prepared) => ({
		prepared,
		execution: executePreparedToolCall(prepared, signal, emit),
	}));

	for (const running of runningCalls) {
		const executed = await running.execution;
		results.push(
			await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				running.prepared,
				executed,
				config,
				signal,
				emit,
			),
		);
	}

	return results;
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		const afterResult = await config.afterToolCall(
			{
				assistantMessage,
				toolCall: prepared.toolCall,
				args: prepared.args,
				result,
				isError,
				context: currentContext,
			},
			signal,
		);
		if (afterResult) {
			result = {
				content: afterResult.content ?? result.content,
				details: afterResult.details ?? result.details,
			};
			isError = afterResult.isError ?? isError;
		}
	}

	return await emitToolCallOutcome(prepared.toolCall, result, isError, emit);
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolCallOutcome(
	toolCall: AgentToolCall,
	result: AgentToolResult<any>,
	isError: boolean,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	await emit({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};

	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
	return toolResultMessage;
}
