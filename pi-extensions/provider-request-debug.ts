import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as os from "node:os";

const REQUEST_LOG_PATH = path.join(os.tmpdir(), "pi-provider-requests.jsonl");

let debugLoggingEnabled = false;

type DebugFilter = {
	modelSubstring: string | null;
	requireTemperature: boolean;
};

const debugFilter: DebugFilter = {
	modelSubstring: null,
	requireTemperature: false,
};

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "success" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function safeJsonStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, (_key, current) => {
		if (typeof current === "bigint") return current.toString();
		if (current && typeof current === "object") {
			if (seen.has(current as object)) return "[Circular]";
			seen.add(current as object);
		}
		return current;
	});
}

function rootTemperature(payload: unknown): number | null {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const value = (payload as Record<string, unknown>).temperature;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractModelFromPayload(payload: unknown): string {
	const stack: unknown[] = [payload];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || typeof current !== "object") continue;
		if (Array.isArray(current)) {
			for (const item of current) stack.push(item);
			continue;
		}
		const obj = current as Record<string, unknown>;
		if (typeof obj.model === "string" && obj.model.trim()) return obj.model;
		for (const value of Object.values(obj)) stack.push(value);
	}
	return "";
}

function modelToString(value: unknown): string {
	if (!value) return "";
	if (typeof value === "string") return value;
	if (typeof value !== "object") return "";
	const obj = value as Record<string, unknown>;
	const provider = typeof obj.provider === "string" ? obj.provider : "";
	const id = typeof obj.id === "string" ? obj.id : "";
	if (provider && id) return `${provider}/${id}`;
	return id;
}

function filterSummary(): string {
	const model = debugFilter.modelSubstring ? `model~"${debugFilter.modelSubstring}"` : "model:any";
	const temp = debugFilter.requireTemperature ? "temperature:required" : "temperature:any";
	return `${model}, ${temp}`;
}

function passesFilter(payload: unknown, model: string): boolean {
	if (debugFilter.modelSubstring) {
		if (!model.toLowerCase().includes(debugFilter.modelSubstring.toLowerCase())) {
			return false;
		}
	}

	if (debugFilter.requireTemperature && rootTemperature(payload) === null) {
		return false;
	}

	return true;
}

async function configureFilterInteractively(ctx: ExtensionCommandContext): Promise<boolean> {
	if (!ctx.hasUI) return false;

	const choice = await ctx.ui.select("Debug filter: what should be logged?", [
		"All requests",
		"Current model only",
		"Custom model substring",
		"Only requests with temperature",
		"Cancel",
	]);

	if (!choice || choice === "Cancel") return false;

	if (choice === "All requests") {
		debugFilter.modelSubstring = null;
		debugFilter.requireTemperature = false;
		return true;
	}

	if (choice === "Current model only") {
		const model = modelToString((ctx as any).model) || modelToString((ctx as any).defaultModel);
		if (!model) {
			notify(ctx, "[debug] could not detect current model; keeping existing filter", "warning");
			return false;
		}
		debugFilter.modelSubstring = model;
		debugFilter.requireTemperature = false;
		return true;
	}

	if (choice === "Custom model substring") {
		const value = await ctx.ui.input("Model substring to match (e.g. Opus4.6-Qwen3.5-27B)");
		if (!value || !value.trim()) {
			notify(ctx, "[debug] empty substring; keeping existing filter", "warning");
			return false;
		}
		debugFilter.modelSubstring = value.trim();
		debugFilter.requireTemperature = false;
		return true;
	}

	if (choice === "Only requests with temperature") {
		debugFilter.modelSubstring = null;
		debugFilter.requireTemperature = true;
		return true;
	}

	return false;
}

async function appendRequestLog(entry: Record<string, unknown>): Promise<void> {
	const line = `${safeJsonStringify(entry)}\n`;
	await fs.appendFile(REQUEST_LOG_PATH, line, "utf8");
}

async function clearRequestLog(): Promise<void> {
	await fs.writeFile(REQUEST_LOG_PATH, "", "utf8");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("debug", {
		description: "Full provider request logging: /debug on|off|status|filter|show-log|clear-log",
		handler: async (args, ctx) => {
			const tokens = args
				.split(/\s+/)
				.map((x) => x.trim().toLowerCase())
				.filter(Boolean);

			const cmd = tokens[0] || "status";
			if (cmd === "on") {
				if (tokens.length === 1 && ctx.hasUI) {
					await configureFilterInteractively(ctx);
				}
				debugLoggingEnabled = true;
				notify(
					ctx,
					`[debug] full request logging enabled -> ${REQUEST_LOG_PATH}; filter: ${filterSummary()}`,
					"info",
				);
				return;
			}
			if (cmd === "off") {
				debugLoggingEnabled = false;
				notify(ctx, "[debug] full request logging disabled", "info");
				return;
			}
			if (cmd === "status") {
				notify(
					ctx,
					`[debug] full request logging ${debugLoggingEnabled ? "ON" : "OFF"}; log=${REQUEST_LOG_PATH}; filter: ${filterSummary()}`,
					"info",
				);
				return;
			}
			if (cmd === "filter") {
				if (!ctx.hasUI) {
					notify(ctx, "[debug] interactive filter requires UI; use /debug on without args in interactive mode", "warning");
					return;
				}
				const changed = await configureFilterInteractively(ctx);
				if (changed) {
					notify(ctx, `[debug] filter updated: ${filterSummary()}`, "info");
				}
				return;
			}
			if (cmd === "show-log") {
				notify(ctx, `[debug] request log: ${REQUEST_LOG_PATH}`, "info");
				return;
			}
			if (cmd === "clear-log") {
				await clearRequestLog();
				notify(ctx, `[debug] cleared request log: ${REQUEST_LOG_PATH}`, "info");
				return;
			}

			notify(
				ctx,
				"[debug] Usage: /debug on | /debug off | /debug status | /debug filter | /debug show-log | /debug clear-log",
				"warning",
			);
		},
	});

	pi.on("before_provider_request", async (event, _ctx) => {
		if (!debugLoggingEnabled) return;
		const model = extractModelFromPayload(event.payload);
		if (!passesFilter(event.payload, model)) return;
		await appendRequestLog({
			timestamp: new Date().toISOString(),
			tag: "provider-request",
			model,
			inputTemperature: rootTemperature(event.payload),
			inputPayload: event.payload,
		});
	});
}
