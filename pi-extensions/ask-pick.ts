import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const normalizeInlineWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

const dedupe = (items: string[]): string[] => {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of items) {
		if (!seen.has(item)) {
			seen.add(item);
			out.push(item);
		}
	}
	return out;
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_pick",
		label: "Ask Pick",
		description:
			"Show a single-choice interactive picker in the TUI and return the selected option.",
		parameters: Type.Object({
			question: Type.String({ description: "Question shown to the user" }),
			options: Type.Array(Type.String({ minLength: 1 }), {
				description: "Answer options (2-5 recommended)",
				minItems: 2,
			}),
			defaultOption: Type.Optional(
				Type.String({ description: "Optional default option hint (must be one of options)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const question = normalizeInlineWhitespace(params.question ?? "");
			const options = dedupe(
				(params.options ?? [])
					.map((o) => normalizeInlineWhitespace(String(o)))
					.filter(Boolean),
			);
			const defaultOption = params.defaultOption
				? normalizeInlineWhitespace(params.defaultOption)
				: undefined;

			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text:
								"Interactive picker is unavailable in this runtime. Ask in plain text with numbered options.",
						},
					],
					details: { interactiveAvailable: false, question, options },
				};
			}

			if (!question || options.length < 2) {
				return {
					content: [
						{
							type: "text",
							text: "Invalid ask_pick input. Need a non-empty question and at least 2 options.",
						},
					],
					details: { ok: false, reason: "invalid_input", question, options },
				};
			}

			if (defaultOption && !options.includes(defaultOption)) {
				ctx.ui.notify(`Default not in options: ${defaultOption}`, "warning");
			}

			const selected = await ctx.ui.select(question, options);
			if (!selected) {
				ctx.ui.notify("Cancelled", "info");
				return {
					content: [{ type: "text", text: "User cancelled the picker." }],
					details: {
						ok: false,
						cancelled: true,
						question,
						options,
					},
				};
			}

			pi.sendMessage(
				{
					customType: "pick",
					content: `Selected option: ${selected}`,
					display: true,
				},
				{ triggerTurn: true },
			);

			return {
				content: [{ type: "text", text: `Selected option: ${selected}` }],
				details: {
					ok: true,
					question,
					options,
					selected,
					defaultOption,
				},
			};
		},
	});
}
