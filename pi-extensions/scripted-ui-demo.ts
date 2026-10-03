import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const MPMUX_SOCKET_ENV = "MPMUX_SOCKET";
const MPMUX_DEFAULT_SOCKET_NAME = "mpmux.sock";
const HOST_TIMEOUT_MS = 5_000;
const HOST_WAIT_TIMEOUT_MS = 15_000;

type HostEventKind =
	| "control-owner-changed"
	| "ui-state-changed"
	| "dialog-state-changed"
	| "custom-dialog-state-changed"
	| "custom-sidebar-state-changed";

type SidebarRow = {
	id: string;
	title: string;
	subtitle?: string;
	status?: string;
	accent?: string;
	meta?: string;
	level?: number;
	detailLines?: string[];
	proof?: string;
	inspectPrompt?: string;
};

type ScriptedSidebarSurface = {
	id: string;
	title: string;
	summary?: Array<{ label: string; value: string }>;
	list: {
		id: string;
		label: string;
		items: SidebarRow[];
		selectedId?: string;
	};
};

type CustomDialogAction = {
	id: string;
	label: string;
	style?: string;
};

type ScriptedDialogSurface = {
	id: string;
	title: string;
	subtitle?: string;
	lines: string[];
	primary?: CustomDialogAction;
	secondary?: CustomDialogAction[];
};

type CustomSidebarInteraction = {
	nonce: number;
	kind: "selection-changed" | "item-invoked";
	source?: string;
	section_id?: string;
	item_id?: string;
};

type CustomSidebarState = {
	open: boolean;
	selected_item_id?: string;
	last_interaction?: CustomSidebarInteraction;
};

type CustomDialogActionEvent = {
	nonce: number;
	result: {
		dialog_id: string;
		action_id: string;
		submitted: boolean;
		values: Array<{ field_id: string; value: unknown }>;
	};
};

type CustomDialogState = {
	open: boolean;
	last_action?: CustomDialogActionEvent;
};

type HostEvent = {
	kind: HostEventKind;
	custom_sidebar?: CustomSidebarState;
	custom_dialog?: CustomDialogState;
};

type HostEventsResponse = {
	client_id: string;
	events: HostEvent[];
	pending_event_count: number;
};

type HostClientState = {
	socketPath: string;
	clientId: string;
	attached: boolean;
};

type ScriptedUiControllerOptions = {
	id: string;
	name: string;
	ctx: ExtensionContext;
	socketPath?: string;
	onItemInvoked?: (itemId: string, source: string, controller: ScriptedUiController) => Promise<void> | void;
	onDialogAction?: (actionId: string, dialogId: string, controller: ScriptedUiController) => Promise<void> | void;
};

function defaultMpmuxSocketPath(): string {
	const explicit = process.env[MPMUX_SOCKET_ENV];
	if (explicit?.trim()) return expandHome(stripAtPrefix(explicit.trim()));
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	if (runtimeDir?.trim()) return path.join(runtimeDir, MPMUX_DEFAULT_SOCKET_NAME);
	if (typeof process.getuid === "function") return path.join("/run/user", String(process.getuid()), MPMUX_DEFAULT_SOCKET_NAME);
	return path.join(os.tmpdir(), MPMUX_DEFAULT_SOCKET_NAME);
}

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function createClientId(id: string): string {
	return `pi-scripted-ui-${id}-${process.pid}-${Date.now().toString(36)}`;
}

function encodeStatus(row: SidebarRow): string | undefined {
	const parts: string[] = [];
	if (row.status) parts.push(row.status);
	if (row.accent) parts.push(`accent:${row.accent}`);
	if (row.meta) parts.push(`meta:${row.meta}`);
	if (row.level && row.level > 0) parts.push(`level:${row.level}`);
	return parts.length ? parts.join("|") : undefined;
}

function toHostSidebar(surface: ScriptedSidebarSurface) {
	const sections: Array<Record<string, unknown>> = [];
	if (surface.summary?.length) {
		sections.push({ kind: "summary", title: "Overview", items: surface.summary });
	}
	sections.push({
		kind: "list",
		id: surface.list.id,
		label: surface.list.label,
		items: surface.list.items.map((item) => ({
			id: item.id,
			title: item.title,
			subtitle: item.subtitle,
			status: encodeStatus(item),
		})),
		selected_id: surface.list.selectedId,
	});
	return { id: surface.id, title: surface.title, sections };
}

function toHostDialog(dialog: ScriptedDialogSurface) {
	return {
		id: dialog.id,
		title: dialog.title,
		subtitle: dialog.subtitle,
		width: "wide",
		dismissable: true,
		submit_on_enter: true,
		sections: [{ kind: "detail", id: "details", title: "Details", lines: dialog.lines }],
		footer: {
			primary: dialog.primary,
			secondary: dialog.secondary ?? [],
		},
	};
}

async function sendHostRequest(
	socketPath: string,
	command: string,
	fields: Record<string, unknown>,
	timeoutMs = HOST_TIMEOUT_MS,
): Promise<unknown> {
	const request = JSON.stringify({ id: `scripted-ui-${Date.now()}`, command, ...fields }) + "\n";
	return await new Promise<unknown>((resolve, reject) => {
		const client = net.createConnection(socketPath);
		let settled = false;
		let buffer = "";

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			client.removeAllListeners();
			client.destroy();
			fn();
		};

		client.setTimeout(timeoutMs, () => {
			finish(() => reject(new Error(`Timed out waiting for mpmux host response from ${socketPath}`)));
		});
		client.on("connect", () => client.write(request));
		client.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			try {
				const parsed = JSON.parse(buffer.slice(0, newlineIndex).trim()) as Record<string, unknown>;
				if (parsed.status === "error") {
					finish(() => reject(new Error(typeof parsed.message === "string" ? parsed.message : `Host command failed: ${command}`)));
					return;
				}
				finish(() => resolve(parsed.status === "ok" ? parsed.data : parsed));
			} catch (error) {
				finish(() => reject(error instanceof Error ? error : new Error(String(error))));
			}
		});
		client.on("error", (error) => finish(() => reject(error)));
		client.on("end", () => finish(() => reject(new Error("Connection closed before a host response was received."))));
	});
}

class ScriptedUiController {
	private readonly state: HostClientState;
	private readonly ctx: ExtensionContext;
	private readonly onItemInvoked?: ScriptedUiControllerOptions["onItemInvoked"];
	private readonly onDialogAction?: ScriptedUiControllerOptions["onDialogAction"];
	private lastSidebarNonce = 0;
	private lastDialogNonce = 0;
	private running = false;

	constructor(options: ScriptedUiControllerOptions) {
		this.ctx = options.ctx;
		this.onItemInvoked = options.onItemInvoked;
		this.onDialogAction = options.onDialogAction;
		this.state = {
			socketPath: options.socketPath ?? defaultMpmuxSocketPath(),
			clientId: createClientId(options.id),
			attached: false,
		};
	}

	async attach(): Promise<void> {
		if (this.state.attached) return;
		await sendHostRequest(this.state.socketPath, "attach", {
			client_id: this.state.clientId,
			target_client_id: this.state.clientId,
			name: "Pi scripted UI demo",
			role: "controller",
		});
		this.state.attached = true;
	}

	async showSidebar(surface: ScriptedSidebarSurface): Promise<void> {
		await this.withControl(async () => {
			await sendHostRequest(this.state.socketPath, "show-custom-sidebar", {
				client_id: this.state.clientId,
				sidebar: toHostSidebar(surface),
			});
		});
	}

	async showDialog(dialog: ScriptedDialogSurface): Promise<void> {
		await this.withControl(async () => {
			await sendHostRequest(this.state.socketPath, "show-custom-dialog", {
				client_id: this.state.clientId,
				dialog: toHostDialog(dialog),
			});
		});
	}

	async displayMessage(message: string): Promise<void> {
		await this.withControl(async () => {
			await sendHostRequest(this.state.socketPath, "display-message", {
				client_id: this.state.clientId,
				message,
			});
		});
	}

	async clearDialog(): Promise<void> {
		await this.withControl(async () => {
			await sendHostRequest(this.state.socketPath, "clear-custom-dialog", { client_id: this.state.clientId });
		});
	}

	async run(signal?: AbortSignal): Promise<void> {
		this.running = true;
		await this.attach();
		await sendHostRequest(this.state.socketPath, "subscribe", {
			client_id: this.state.clientId,
			events: ["custom-sidebar-state-changed", "custom-dialog-state-changed"],
		});
		try {
			while (this.running && !signal?.aborted) {
				const response = await this.waitForEvents().catch((error) => {
					if (error instanceof Error && /timed out waiting/i.test(error.message)) return null;
					throw error;
				});
				if (!response) continue;
				for (const event of response.events) {
					await this.handleEvent(event);
				}
			}
		} finally {
			await this.clear().catch(() => undefined);
			await this.detach().catch(() => undefined);
		}
	}

	stop(): void {
		this.running = false;
	}

	private async waitForEvents(): Promise<HostEventsResponse> {
		await this.attach();
		return (await sendHostRequest(this.state.socketPath, "wait-for-events", {
			client_id: this.state.clientId,
			max_events: 8,
		}, HOST_WAIT_TIMEOUT_MS)) as HostEventsResponse;
	}

	private async handleEvent(event: HostEvent): Promise<void> {
		const sidebar = event.custom_sidebar;
		if (sidebar) {
			if (!sidebar.open) {
				this.stop();
				return;
			}
			const interaction = sidebar.last_interaction;
			if (interaction?.item_id && interaction.kind === "item-invoked" && interaction.nonce > this.lastSidebarNonce) {
				this.lastSidebarNonce = interaction.nonce;
				await this.onItemInvoked?.(interaction.item_id, interaction.source ?? "keyboard", this);
			}
		}

		const dialogAction = event.custom_dialog?.last_action;
		if (dialogAction && dialogAction.nonce > this.lastDialogNonce) {
			this.lastDialogNonce = dialogAction.nonce;
			await this.onDialogAction?.(dialogAction.result.action_id, dialogAction.result.dialog_id, this);
		}
	}

	private async withControl<T>(fn: () => Promise<T>): Promise<T> {
		await this.attach();
		await sendHostRequest(this.state.socketPath, "acquire-control", {
			client_id: this.state.clientId,
			target_client_id: this.state.clientId,
		});
		try {
			return await fn();
		} finally {
			await sendHostRequest(this.state.socketPath, "release-control", {
				client_id: this.state.clientId,
				target_client_id: this.state.clientId,
			}).catch(() => undefined);
		}
	}

	private async clear(): Promise<void> {
		await this.withControl(async () => {
			await sendHostRequest(this.state.socketPath, "clear-custom-dialog", { client_id: this.state.clientId }).catch(() => undefined);
			await sendHostRequest(this.state.socketPath, "clear-custom-sidebar", { client_id: this.state.clientId }).catch(() => undefined);
		});
	}

	private async detach(): Promise<void> {
		if (!this.state.attached) return;
		await sendHostRequest(this.state.socketPath, "detach", {
			client_id: this.state.clientId,
			target_client_id: this.state.clientId,
		}).catch(() => undefined);
		this.state.attached = false;
	}
}

const DEMO_ROWS: SidebarRow[] = [
	{
		id: "dataset-users",
		title: "Users cohort",
		subtitle: "1,204 rows • identity + plan fields",
		status: "READY",
		accent: "#7aa2f7",
		meta: "4 fields",
		detailLines: [
			"Dataset: users",
			"Rows: 1,204",
			"Fields: id, name, plan, last_seen",
			"Scenario: stable baseline row for sidebar selection and metadata rendering.",
		],
		proof: "Baseline data rows can render status, accent, metadata, and a detail dialog without todo-specific code.",
		inspectPrompt: "Inspect the scripted UI Data Inspector demo Users cohort fixture and summarize what the selected fixture proves.",
	},
	{
		id: "dataset-orders",
		title: "Orders stream",
		subtitle: "342 rows • joins users by user_id",
		status: "READY",
		accent: "#9ece6a",
		meta: "3 joins",
		detailLines: [
			"Dataset: orders",
			"Rows: 342",
			"Join key: user_id",
			"Notable state: 7 pending refunds",
			"Scenario: related data row with a different semantic action target.",
		],
		proof: "The same scripted sidebar contract can represent related domain entities and preserve row-specific action context.",
		inspectPrompt: "Inspect the scripted UI Data Inspector demo Orders stream fixture and summarize what the selected fixture proves.",
	},
	{
		id: "dataset-errors",
		title: "Error events",
		subtitle: "19 rows • grouped by severity",
		status: "WARN",
		accent: "#e0af68",
		meta: "2 severe",
		detailLines: [
			"Dataset: errors",
			"Rows: 19",
			"Severe: 2",
			"Grouping: severity, source, first_seen",
			"Scenario: warning-state row for visual status and action-routing proof.",
		],
		proof: "Warning-state rows can use distinct status, accent, and metadata while sharing the same dialog/action lifecycle.",
		inspectPrompt: "Inspect the scripted UI Data Inspector demo Error events fixture and summarize what the selected fixture proves.",
	},
];

function buildDemoSidebar(selectedId = DEMO_ROWS[0]?.id): ScriptedSidebarSurface {
	return {
		id: "scripted-data-inspector-demo",
		title: "Data Inspector",
		summary: [
			{ label: "Story", value: "customer health" },
			{ label: "Rows", value: String(DEMO_ROWS.length) },
			{ label: "Runtime", value: "TypeScript controller" },
		],
		list: {
			id: "datasets",
			label: "Fixture datasets",
			items: DEMO_ROWS,
			selectedId,
		},
	};
}

function buildDemoDialog(row: SidebarRow): ScriptedDialogSurface {
	return {
		id: `scripted-data-inspector-${row.id}`,
		title: row.title,
		subtitle: "Data Inspector proof fixture",
		lines: [
			...(row.detailLines ?? [row.subtitle ?? "No details."]),
			"",
			`Proof: ${row.proof ?? "This row exercises the scripted sidebar/dialog model."}`,
		],
		primary: { id: "inspect", label: "Inspect", style: "primary" },
		secondary: [
			{ id: "refresh", label: "Refresh" },
			{ id: "close", label: "Close" },
		],
	};
}

export default function scriptedUiDemoExtension(pi: ExtensionAPI) {
	let activeRun: { controller: ScriptedUiController; abort: AbortController; promise: Promise<void> } | null = null;

	const stopActive = () => {
		activeRun?.controller.stop();
		activeRun?.abort.abort();
		activeRun = null;
	};

	pi.on("session_shutdown", () => {
		stopActive();
	});

	pi.registerCommand("scripted-ui-demo", {
		description: "Open a generalized scripted UI Data Inspector demo in mpmux",
		handler: async (args, ctx) => {
			if ((args ?? "").trim() === "--clear") {
				stopActive();
				ctx.ui.notify("Cleared scripted UI demo", "info");
				return;
			}
			if (!ctx.hasUI) {
				console.log("/scripted-ui-demo requires the Pi UI and an mpmux host session.");
				return;
			}

			stopActive();
			const abort = new AbortController();
			let activeRow = DEMO_ROWS[0];
			const controller = new ScriptedUiController({
				id: "data-inspector-demo",
				name: "Data Inspector demo",
				ctx,
				onItemInvoked: async (itemId, _source, activeController) => {
					activeRow = DEMO_ROWS.find((item) => item.id === itemId) ?? DEMO_ROWS[0];
					await activeController.showDialog(buildDemoDialog(activeRow));
				},
				onDialogAction: async (actionId, _dialogId, activeController) => {
					if (actionId === "inspect") {
						pi.sendUserMessage(activeRow.inspectPrompt ?? "Inspect the scripted UI Data Inspector demo and summarize what the selected fixture proves.", { deliverAs: "steer" });
						return;
					}
					if (actionId === "refresh") {
						await activeController.showSidebar(buildDemoSidebar(activeRow.id));
						await activeController.displayMessage(`Refreshed ${activeRow.title}`);
						return;
					}
					if (actionId === "close") {
						await activeController.clearDialog();
					}
				},
			});
			await controller.attach();
			await controller.showSidebar(buildDemoSidebar());
			const promise = controller.run(abort.signal).catch((error) => {
				ctx.ui.notify(`scripted UI demo failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}).finally(() => {
				if (activeRun?.controller === controller) activeRun = null;
			});
			activeRun = { controller, abort, promise };
			ctx.ui.notify("Opened scripted UI Data Inspector demo", "info");
		},
	});
}
