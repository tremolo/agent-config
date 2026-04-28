/**
 * This extension stores todo items as files under <todo-dir> (defaults to .pi/todos,
 * or the path in PI_TODO_PATH).  Each todo is a standalone markdown file named
 * <id>.md and an optional <id>.lock file is used while a session is editing it.
 *
 * File format in .pi/todos:
 * - The file starts with a JSON object (not YAML) containing the front matter:
 *   { id, title, tags, status, created_at, assigned_to_session }
 * - After the JSON block comes optional markdown body text separated by a blank line.
 * - Example:
 *   {
 *     "id": "deadbeef",
 *     "title": "Add tests",
 *     "tags": ["qa"],
 *     "status": "open",
 *     "created_at": "2026-01-25T17:00:00.000Z",
 *     "assigned_to_session": "session.json"
 *   }
 *
 *   Notes about the work go here.
 *
 * Todo storage settings are kept in <todo-dir>/settings.json.
 * Defaults:
 * {
 *   "gc": true,   // delete closed todos older than gcDays on startup
 *   "gcDays": 7   // age threshold for GC (days since created_at)
 * }
 *
 * Use `/todos` to bring up the visual todo manager or just let the LLM use them
 * naturally.
 */
import {
	DynamicBorder,
	copyToClipboard,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import {
	Container,
	type Focusable,
	Input,
	Key,
	Markdown,
	SelectList,
	Spacer,
	type SelectItem,
	Text,
	TUI,
	fuzzyMatch,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";

const TODO_DIR_NAME = ".pi/todos";
const TODO_PATH_ENV = "PI_TODO_PATH";
const TODO_SETTINGS_NAME = "settings.json";
const TODO_INDEX_NAME = "index.json";
const TODO_ID_PREFIX = "TODO-";
const TODO_ID_PATTERN = /^[a-f0-9]{8}$/i;
const DEFAULT_TODO_SETTINGS = {
	gc: true,
	gcDays: 7,
};
const LOCK_TTL_MS = 30 * 60 * 1000;
const MPMUX_SOCKET_ENV = "MPMUX_SOCKET_PATH";
const MPMUX_DEFAULT_SOCKET_NAME = "mpmux.sock";
const MPMUX_HOST_TIMEOUT_MS = 5_000;

interface TodoFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	updated_at?: string;
	group_colour?: string;
	assigned_to_session?: string;
	last_worked_at?: string;
	last_worked_by_session?: string;
}

interface TodoRecord extends TodoFrontMatter {
	body: string;
}

interface LockInfo {
	id: string;
	pid: number;
	session?: string | null;
	created_at: string;
}

interface TodoSettings {
	gc: boolean;
	gcDays: number;
}

type TodoRelationshipKind =
	| "parent"
	| "child"
	| "depends_on"
	| "blocks"
	| "related_to"
	| "duplicate_of"
	| "umbrella"
	| "subtask";

type TodoRelationshipEdge = {
	from: string;
	to: string;
	kind: TodoRelationshipKind;
	source: "structured-text" | "explicit-reference" | "computed";
	context?: string;
};

type TodoIndexItem = TodoFrontMatter & {
	display_id: string;
	closed: boolean;
};

type TodoIndexGraphNode = {
	id: string;
	parent_ids: string[];
	child_ids: string[];
	sibling_ids: string[];
	depends_on: string[];
	blocks: string[];
	related_to: string[];
	duplicate_of: string[];
};

type TodoIndex = {
	version: 1;
	generated_at: string;
	summary: {
		total: number;
		open: number;
		closed: number;
		visible_default_limit: number;
	};
	todos: TodoIndexItem[];
	groups: {
		tags: Record<string, string[]>;
		status: Record<string, string[]>;
		recently_worked: string[];
	};
	graph: {
		edges: TodoRelationshipEdge[];
		nodes: Record<string, TodoIndexGraphNode>;
	};
};

type KeybindingMatcher = {
	matches: (keyData: string, keybindingId: string) => boolean;
};

type TodoSelectionChangeCallback = (
	todo: TodoFrontMatter | null,
	state: { search: string; filteredTodos: TodoFrontMatter[] },
) => void;

type MpmuxHostSidebarState = {
	socketPath: string;
	clientId: string;
	attached: boolean;
};

type MpmuxHostEventKind =
	| "control-owner-changed"
	| "ui-state-changed"
	| "dialog-state-changed"
	| "custom-dialog-state-changed"
	| "custom-sidebar-state-changed";

type MpmuxCustomSidebarInteraction = {
	nonce: number;
	kind: "selection-changed" | "item-invoked";
	source?: string;
	section_id?: string;
	item_id?: string;
};

type MpmuxCustomSidebarState = {
	open: boolean;
	id?: string;
	title?: string;
	section_count: number;
	rendered_text?: string;
	selected_item_id?: string;
	last_interaction?: MpmuxCustomSidebarInteraction;
};

type MpmuxCustomDialogActionEvent = {
	nonce: number;
	result: {
		dialog_id: string;
		action_id: string;
		submitted: boolean;
		values: Array<{ field_id: string; value: unknown }>;
	};
};

type MpmuxCustomDialogState = {
	open: boolean;
	id?: string;
	title?: string;
	last_action?: MpmuxCustomDialogActionEvent;
};

type MpmuxUiState = {
	message_sidebar: {
		open: boolean;
		maximize_mode: boolean;
		visible_width_px?: number;
	};
	custom_sidebar: MpmuxCustomSidebarState;
	custom_dialog: MpmuxCustomDialogState;
};

type MpmuxHostEvent = {
	kind: MpmuxHostEventKind;
	ui_state?: MpmuxUiState;
	custom_sidebar?: MpmuxCustomSidebarState;
	custom_dialog?: MpmuxCustomDialogState;
};

type MpmuxHostPollEventsResponse = {
	client_id: string;
	events: MpmuxHostEvent[];
	pending_event_count: number;
};

const TodoParams = Type.Object({
	action: StringEnum([
		"list",
		"list-all",
		"get",
		"create",
		"update",
		"append",
		"delete",
		"claim",
		"release",
		"refresh-index",
	] as const),
	id: Type.Optional(
		Type.String({ description: "Todo id (TODO-<hex> or raw hex filename)" }),
	),
	title: Type.Optional(Type.String({ description: "Short summary shown in lists" })),
	status: Type.Optional(Type.String({ description: "Todo status" })),
	tags: Type.Optional(Type.Array(Type.String({ description: "Todo tag" }))),
	group_colour: Type.Optional(Type.String({ description: "Optional parent/group colour as #rrggbb for sidebar relationship accents" })),
	body: Type.Optional(
		Type.String({ description: "Long-form details (markdown). Update replaces; append adds." }),
	),
	force: Type.Optional(Type.Boolean({ description: "Override another session's assignment" })),
});

type TodoAction =
	| "list"
	| "list-all"
	| "get"
	| "create"
	| "update"
	| "append"
	| "delete"
	| "claim"
	| "release"
	| "refresh-index";

type TodoOverlayAction = "back" | "work";

type TodoMenuAction =
	| "work"
	| "refine"
	| "close"
	| "reopen"
	| "release"
	| "delete"
	| "copyPath"
	| "copyText"
	| "view";

type TodoToolDetails =
	| { action: "list" | "list-all"; todos: TodoFrontMatter[]; currentSessionId?: string; error?: string }
	| { action: "refresh-index"; index: TodoIndex; error?: string }
	| {
			action: "get" | "create" | "update" | "append" | "delete" | "claim" | "release";
			todo: TodoRecord;
			error?: string;
		};

function formatTodoId(id: string): string {
	return `${TODO_ID_PREFIX}${id}`;
}

function normalizeTodoId(id: string): string {
	let trimmed = id.trim();
	if (trimmed.startsWith("#")) {
		trimmed = trimmed.slice(1);
	}
	if (trimmed.toUpperCase().startsWith(TODO_ID_PREFIX)) {
		trimmed = trimmed.slice(TODO_ID_PREFIX.length);
	}
	return trimmed;
}

function validateTodoId(id: string): { id: string } | { error: string } {
	const normalized = normalizeTodoId(id);
	if (!normalized || !TODO_ID_PATTERN.test(normalized)) {
		return { error: "Invalid todo id. Expected TODO-<hex>." };
	}
	return { id: normalized.toLowerCase() };
}

function displayTodoId(id: string): string {
	return formatTodoId(normalizeTodoId(id));
}

function isTodoClosed(status: string): boolean {
	return ["closed", "done"].includes(status.toLowerCase());
}

function clearAssignmentIfClosed(todo: TodoFrontMatter): void {
	if (isTodoClosed(getTodoStatus(todo))) {
		todo.assigned_to_session = undefined;
	}
}

function sortTodos(todos: TodoFrontMatter[]): TodoFrontMatter[] {
	return [...todos].sort((a, b) => {
		const aClosed = isTodoClosed(a.status);
		const bClosed = isTodoClosed(b.status);
		if (aClosed !== bClosed) return aClosed ? 1 : -1;
		const aAssigned = !aClosed && Boolean(a.assigned_to_session);
		const bAssigned = !bClosed && Boolean(b.assigned_to_session);
		if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
		return (a.created_at || "").localeCompare(b.created_at || "");
	});
}

function buildTodoSearchText(todo: TodoFrontMatter): string {
	const tags = todo.tags.join(" ");
	const assignment = todo.assigned_to_session ? `assigned:${todo.assigned_to_session}` : "";
	const workedBy = todo.last_worked_by_session ? `worked:${todo.last_worked_by_session}` : "";
	return `${formatTodoId(todo.id)} ${todo.id} ${todo.title} ${tags} ${todo.status} ${assignment} ${workedBy} ${todo.updated_at ?? ""}`.trim();
}

function filterTodos(todos: TodoFrontMatter[], query: string): TodoFrontMatter[] {
	const trimmed = query.trim();
	if (!trimmed) return todos;

	const tokens = trimmed
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);

	if (tokens.length === 0) return todos;

	const matches: Array<{ todo: TodoFrontMatter; score: number }> = [];
	for (const todo of todos) {
		const text = buildTodoSearchText(todo);
		let totalScore = 0;
		let matched = true;
		for (const token of tokens) {
			const result = fuzzyMatch(token, text);
			if (!result.matches) {
				matched = false;
				break;
			}
			totalScore += result.score;
		}
		if (matched) {
			matches.push({ todo, score: totalScore });
		}
	}

	return matches
		.sort((a, b) => {
			const aClosed = isTodoClosed(a.todo.status);
			const bClosed = isTodoClosed(b.todo.status);
			if (aClosed !== bClosed) return aClosed ? 1 : -1;
			const aAssigned = !aClosed && Boolean(a.todo.assigned_to_session);
			const bAssigned = !bClosed && Boolean(b.todo.assigned_to_session);
			if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
			return a.score - b.score;
		})
		.map((match) => match.todo);
}

class TodoSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private listContainer: Container;
	private allTodos: TodoFrontMatter[];
	private filteredTodos: TodoFrontMatter[];
	private selectedIndex = 0;
	private onSelectCallback: (todo: TodoFrontMatter) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private theme: Theme;
	private keybindings: KeybindingMatcher;
	private headerText: Text;
	private hintText: Text;
	private currentSessionId?: string;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingMatcher,
		todos: TodoFrontMatter[],
		onSelect: (todo: TodoFrontMatter) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		currentSessionId?: string,
		private onQuickAction?: (todo: TodoFrontMatter, action: "work" | "refine") => void,
		private onSelectionChange?: TodoSelectionChangeCallback,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.currentSessionId = currentSessionId;
		this.allTodos = todos;
		this.filteredTodos = todos;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));

		this.headerText = new Text("", 1, 0);
		this.addChild(this.headerText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		this.updateHeader();
		this.updateHints();
		this.applyFilter(this.searchInput.getValue());
	}

	setTodos(todos: TodoFrontMatter[]): void {
		this.allTodos = todos;
		this.updateHeader();
		this.applyFilter(this.searchInput.getValue());
		this.tui.requestRender();
	}

	getSearchValue(): string {
		return this.searchInput.getValue();
	}

	getSelectedTodo(): TodoFrontMatter | null {
		return this.filteredTodos[this.selectedIndex] ?? null;
	}

	private updateHeader(): void {
		const openCount = this.allTodos.filter((todo) => !isTodoClosed(todo.status)).length;
		const closedCount = this.allTodos.length - openCount;
		const title = `Todos (${openCount} open, ${closedCount} closed)`;
		this.headerText.setText(this.theme.fg("accent", this.theme.bold(title)));
	}

	private updateHints(): void {
		this.hintText.setText(
			this.theme.fg(
				"dim",
				"Type to search • ↑↓ select • Enter actions • Ctrl+Shift+W work • Ctrl+Shift+R refine • Esc close",
			),
		);
	}

	private applyFilter(query: string): void {
		this.filteredTodos = filterTodos(this.allTodos, query);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredTodos.length - 1));
		this.updateList();
		this.emitSelectionChange();
	}

	private emitSelectionChange(): void {
		this.onSelectionChange?.(this.getSelectedTodo(), {
			search: this.getSearchValue(),
			filteredTodos: [...this.filteredTodos],
		});
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredTodos.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching todos"), 0, 0));
			return;
		}

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredTodos.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredTodos.length);

		for (let i = startIndex; i < endIndex; i += 1) {
			const todo = this.filteredTodos[i];
			if (!todo) continue;
			const isSelected = i === this.selectedIndex;
			const closed = isTodoClosed(todo.status);
			const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const titleColor = isSelected ? "accent" : closed ? "dim" : "text";
			const statusColor = closed ? "dim" : "success";
			const tagText = todo.tags.length ? ` [${todo.tags.join(", ")}]` : "";
			const assignmentText = renderAssignmentSuffix(this.theme, todo, this.currentSessionId);
			const line =
				prefix +
				this.theme.fg("accent", formatTodoId(todo.id)) +
				" " +
				this.theme.fg(titleColor, todo.title || "(untitled)") +
				this.theme.fg("muted", tagText) +
				assignmentText +
				" " +
				this.theme.fg(statusColor, `(${todo.status || "open"})`);
			this.listContainer.addChild(new Text(line, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredTodos.length) {
			const scrollInfo = this.theme.fg(
				"dim",
				`  (${this.selectedIndex + 1}/${this.filteredTodos.length})`,
			);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredTodos.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredTodos.length - 1 : this.selectedIndex - 1;
			this.updateList();
			this.emitSelectionChange();
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredTodos.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredTodos.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			this.emitSelectionChange();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}
		if (matchesKey(keyData, Key.ctrlShift("r"))) {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected && this.onQuickAction) this.onQuickAction(selected, "refine");
			return;
		}
		if (matchesKey(keyData, Key.ctrlShift("w"))) {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected && this.onQuickAction) this.onQuickAction(selected, "work");
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	override invalidate(): void {
		super.invalidate();
		this.updateHeader();
		this.updateHints();
		this.updateList();
	}
}

class TodoActionMenuComponent extends Container {
	private selectList: SelectList;
	private onSelectCallback: (action: TodoMenuAction) => void;
	private onCancelCallback: () => void;

	constructor(
		theme: Theme,
		todo: TodoRecord,
		onSelect: (action: TodoMenuAction) => void,
		onCancel: () => void,
	) {
		super();
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		const closed = isTodoClosed(todo.status);
		const title = todo.title || "(untitled)";
		const options: SelectItem[] = [
			{ value: "view", label: "view", description: "View todo" },
			{ value: "work", label: "work", description: "Work on todo" },
			{ value: "refine", label: "refine", description: "Refine task" },
			...(closed
				? [{ value: "reopen", label: "reopen", description: "Reopen todo" }]
				: [{ value: "close", label: "close", description: "Close todo" }]),
			...(todo.assigned_to_session
				? [{ value: "release", label: "release", description: "Release assignment" }]
				: []),
			{ value: "copyPath", label: "copy path", description: "Copy absolute path to clipboard" },
			{ value: "copyText", label: "copy text", description: "Copy title and body to clipboard" },
			{ value: "delete", label: "delete", description: "Delete todo" },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(
			new Text(
				theme.fg(
					"accent",
					theme.bold(`Actions for ${formatTodoId(todo.id)} "${title}"`),
				),
			),
		);

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		this.selectList.onSelect = (item) => this.onSelectCallback(item.value as TodoMenuAction);
		this.selectList.onCancel = () => this.onCancelCallback();

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg("dim", "Enter to confirm • Esc back")));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

	override invalidate(): void {
		super.invalidate();
	}
}

class TodoDeleteConfirmComponent extends Container {
	private selectList: SelectList;
	private onConfirm: (confirmed: boolean) => void;

	constructor(theme: Theme, message: string, onConfirm: (confirmed: boolean) => void) {
		super();
		this.onConfirm = onConfirm;

		const options: SelectItem[] = [
			{ value: "yes", label: "Yes" },
			{ value: "no", label: "No" },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Text(theme.fg("accent", message)));

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		this.selectList.onSelect = (item) => this.onConfirm(item.value === "yes");
		this.selectList.onCancel = () => this.onConfirm(false);

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg("dim", "Enter to confirm • Esc back")));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

	override invalidate(): void {
		super.invalidate();
	}
}

class TodoDetailOverlayComponent {
	private todo: TodoRecord;
	private theme: Theme;
	private tui: TUI;
	private markdown: Markdown;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	private onAction: (action: TodoOverlayAction) => void;
	private keybindings: KeybindingMatcher;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingMatcher,
		todo: TodoRecord,
		onAction: (action: TodoOverlayAction) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.todo = todo;
		this.onAction = onAction;
		this.markdown = new Markdown(this.getMarkdownText(), 1, 0, getMarkdownTheme());
	}

	private getMarkdownText(): string {
		const body = this.todo.body?.trim();
		return body ? body : "_No details yet._";
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onAction("back");
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.onAction("work");
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			this.scrollBy(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.scrollBy(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageUp") || matchesKey(keyData, Key.left)) {
			this.scrollBy(-this.viewHeight || -1);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageDown") || matchesKey(keyData, Key.right)) {
			this.scrollBy(this.viewHeight || 1);
			return;
		}
	}

	render(width: number): string[] {
		const maxHeight = this.getMaxHeight();
		const headerLines = 3;
		const footerLines = 3;
		const borderLines = 2;
		const innerWidth = Math.max(10, width - 2);
		const contentHeight = Math.max(1, maxHeight - headerLines - footerLines - borderLines);

		const markdownLines = this.markdown.render(innerWidth);
		this.totalLines = markdownLines.length;
		this.viewHeight = contentHeight;
		const maxScroll = Math.max(0, this.totalLines - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleLines = markdownLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		const lines: string[] = [];

		lines.push(this.buildTitleLine(innerWidth));
		lines.push(this.buildMetaLine(innerWidth));
		lines.push("");

		for (const line of visibleLines) {
			lines.push(truncateToWidth(line, innerWidth));
		}
		while (lines.length < headerLines + contentHeight) {
			lines.push("");
		}

		lines.push("");
		lines.push(this.buildActionLine(innerWidth));

		const borderColor = (text: string) => this.theme.fg("borderMuted", text);
		const top = borderColor(`┌${"─".repeat(innerWidth)}┐`);
		const bottom = borderColor(`└${"─".repeat(innerWidth)}┘`);
		const framedLines = lines.map((line) => {
			const truncated = truncateToWidth(line, innerWidth);
			const padding = Math.max(0, innerWidth - visibleWidth(truncated));
			return borderColor("│") + truncated + " ".repeat(padding) + borderColor("│");
		});

		return [top, ...framedLines, bottom].map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.markdown = new Markdown(this.getMarkdownText(), 1, 0, getMarkdownTheme());
	}

	private getMaxHeight(): number {
		const rows = this.tui.terminal.rows || 24;
		return Math.max(10, Math.floor(rows * 0.8));
	}

	private buildTitleLine(width: number): string {
		const titleText = this.todo.title
			? ` ${this.todo.title} `
			: ` Todo ${formatTodoId(this.todo.id)} `;
		const titleWidth = visibleWidth(titleText);
		if (titleWidth >= width) {
			return truncateToWidth(this.theme.fg("accent", titleText.trim()), width);
		}
		const leftWidth = Math.max(0, Math.floor((width - titleWidth) / 2));
		const rightWidth = Math.max(0, width - titleWidth - leftWidth);
		return (
			this.theme.fg("borderMuted", "─".repeat(leftWidth)) +
			this.theme.fg("accent", titleText) +
			this.theme.fg("borderMuted", "─".repeat(rightWidth))
		);
	}

	private buildMetaLine(width: number): string {
		const status = this.todo.status || "open";
		const statusColor = isTodoClosed(status) ? "dim" : "success";
		const tagText = this.todo.tags.length ? this.todo.tags.join(", ") : "no tags";
		const line =
			this.theme.fg("accent", formatTodoId(this.todo.id)) +
			this.theme.fg("muted", " • ") +
			this.theme.fg(statusColor, status) +
			this.theme.fg("muted", " • ") +
			this.theme.fg("muted", tagText);
		return truncateToWidth(line, width);
	}

	private buildActionLine(width: number): string {
		const work = this.theme.fg("accent", "enter") + this.theme.fg("muted", " work on todo");
		const back = this.theme.fg("dim", "esc back");
		const nav = this.theme.fg("dim", "↑/↓: move. ←/→: page.");
		const pieces = [work, back, nav];

		let line = pieces.join(this.theme.fg("muted", " • "));
		if (this.totalLines > this.viewHeight) {
			const start = Math.min(this.totalLines, this.scrollOffset + 1);
			const end = Math.min(this.totalLines, this.scrollOffset + this.viewHeight);
			const scrollInfo = this.theme.fg("dim", ` ${start}-${end}/${this.totalLines}`);
			line += scrollInfo;
		}

		return truncateToWidth(line, width);
	}

	private scrollBy(delta: number): void {
		const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
	}
}

function getTodosDir(cwd: string): string {
	const overridePath = process.env[TODO_PATH_ENV];
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	return path.resolve(cwd, TODO_DIR_NAME);
}

function getTodosDirLabel(cwd: string): string {
	const overridePath = process.env[TODO_PATH_ENV];
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	return TODO_DIR_NAME;
}

function getTodoSettingsPath(todosDir: string): string {
	return path.join(todosDir, TODO_SETTINGS_NAME);
}

function normalizeTodoSettings(raw: Partial<TodoSettings>): TodoSettings {
	const gc = raw.gc ?? DEFAULT_TODO_SETTINGS.gc;
	const gcDays = Number.isFinite(raw.gcDays) ? raw.gcDays : DEFAULT_TODO_SETTINGS.gcDays;
	return {
		gc: Boolean(gc),
		gcDays: Math.max(0, Math.floor(gcDays)),
	};
}

async function readTodoSettings(todosDir: string): Promise<TodoSettings> {
	const settingsPath = getTodoSettingsPath(todosDir);
	let data: Partial<TodoSettings> = {};

	try {
		const raw = await fs.readFile(settingsPath, "utf8");
		data = JSON.parse(raw) as Partial<TodoSettings>;
	} catch {
		data = {};
	}

	return normalizeTodoSettings(data);
}

async function garbageCollectTodos(todosDir: string, settings: TodoSettings): Promise<void> {
	if (!settings.gc) return;

	let entries: string[] = [];
	try {
		entries = await fs.readdir(todosDir);
	} catch {
		return;
	}

	const cutoff = Date.now() - settings.gcDays * 24 * 60 * 60 * 1000;
	await Promise.all(
		entries
			.filter((entry) => entry.endsWith(".md"))
			.map(async (entry) => {
				const id = entry.slice(0, -3);
				const filePath = path.join(todosDir, entry);
				try {
					const content = await fs.readFile(filePath, "utf8");
					const { frontMatter } = splitFrontMatter(content);
					const parsed = parseFrontMatter(frontMatter, id);
					if (!isTodoClosed(parsed.status)) return;
					const createdAt = Date.parse(parsed.created_at);
					if (!Number.isFinite(createdAt)) return;
					if (createdAt < cutoff) {
						await fs.unlink(filePath);
					}
				} catch {
					// ignore unreadable todo
				}
			}),
	);
}

function getTodoPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.md`);
}

function getLockPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.lock`);
}

function normalizeTodoGroupColour(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	const match = /^#?([0-9a-f]{6})$/i.exec(trimmed);
	return match ? `#${match[1].toLowerCase()}` : undefined;
}

function parseFrontMatter(text: string, idFallback: string): TodoFrontMatter {
	const data: TodoFrontMatter = {
		id: idFallback,
		title: "",
		tags: [],
		status: "open",
		created_at: "",
		updated_at: undefined,
		group_colour: undefined,
		assigned_to_session: undefined,
		last_worked_at: undefined,
		last_worked_by_session: undefined,
	};

	const trimmed = text.trim();
	if (!trimmed) return data;

	try {
		const parsed = JSON.parse(trimmed) as Partial<TodoFrontMatter> | null;
		if (!parsed || typeof parsed !== "object") return data;
		if (typeof parsed.id === "string" && parsed.id) data.id = parsed.id;
		if (typeof parsed.title === "string") data.title = parsed.title;
		if (typeof parsed.status === "string" && parsed.status) data.status = parsed.status;
		if (typeof parsed.created_at === "string") data.created_at = parsed.created_at;
		if (typeof parsed.updated_at === "string" && parsed.updated_at.trim()) data.updated_at = parsed.updated_at;
		if (typeof parsed.group_colour === "string" && normalizeTodoGroupColour(parsed.group_colour)) {
			data.group_colour = normalizeTodoGroupColour(parsed.group_colour);
		}
		if (typeof parsed.last_worked_at === "string" && parsed.last_worked_at.trim()) data.last_worked_at = parsed.last_worked_at;
		if (typeof parsed.last_worked_by_session === "string" && parsed.last_worked_by_session.trim()) {
			data.last_worked_by_session = parsed.last_worked_by_session;
		}
		if (typeof parsed.assigned_to_session === "string" && parsed.assigned_to_session.trim()) {
			data.assigned_to_session = parsed.assigned_to_session;
		}
		if (Array.isArray(parsed.tags)) {
			data.tags = parsed.tags.filter((tag): tag is string => typeof tag === "string");
		}
	} catch {
		return data;
	}

	return data;
}

function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < content.length; i += 1) {
		const char = content[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === "\"") {
				inString = false;
			}
			continue;
		}

		if (char === "\"") {
			inString = true;
			continue;
		}

		if (char === "{") {
			depth += 1;
			continue;
		}

		if (char === "}") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}

	return -1;
}

function splitFrontMatter(content: string): { frontMatter: string; body: string } {
	if (!content.startsWith("{")) {
		return { frontMatter: "", body: content };
	}

	const endIndex = findJsonObjectEnd(content);
	if (endIndex === -1) {
		return { frontMatter: "", body: content };
	}

	const frontMatter = content.slice(0, endIndex + 1);
	const body = content.slice(endIndex + 1).replace(/^\r?\n+/, "");
	return { frontMatter, body };
}

function parseTodoContent(content: string, idFallback: string): TodoRecord {
	const { frontMatter, body } = splitFrontMatter(content);
	const parsed = parseFrontMatter(frontMatter, idFallback);
	return {
		id: idFallback,
		title: parsed.title,
		tags: parsed.tags ?? [],
		status: parsed.status,
		created_at: parsed.created_at,
		updated_at: parsed.updated_at,
		group_colour: parsed.group_colour,
		assigned_to_session: parsed.assigned_to_session,
		last_worked_at: parsed.last_worked_at,
		last_worked_by_session: parsed.last_worked_by_session,
		body: body ?? "",
	};
}

function markTodoUpdated(todo: TodoRecord, timestamp = new Date().toISOString()): void {
	todo.updated_at = timestamp;
}

function markTodoWorked(todo: TodoRecord, sessionId: string, timestamp = new Date().toISOString()): void {
	todo.last_worked_at = timestamp;
	todo.last_worked_by_session = sessionId;
}

function serializeTodo(todo: TodoRecord): string {
	const frontMatter = JSON.stringify(
		{
			id: todo.id,
			title: todo.title,
			tags: todo.tags ?? [],
			status: todo.status,
			created_at: todo.created_at,
			updated_at: todo.updated_at || undefined,
			group_colour: normalizeTodoGroupColour(todo.group_colour),
			assigned_to_session: todo.assigned_to_session || undefined,
			last_worked_at: todo.last_worked_at || undefined,
			last_worked_by_session: todo.last_worked_by_session || undefined,
		},
		null,
		2,
	);

	const body = todo.body ?? "";
	const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
	if (!trimmedBody) return `${frontMatter}\n`;
	return `${frontMatter}\n\n${trimmedBody}\n`;
}

async function ensureTodosDir(todosDir: string) {
	await fs.mkdir(todosDir, { recursive: true });
}

async function readTodoFile(filePath: string, idFallback: string): Promise<TodoRecord> {
	const content = await fs.readFile(filePath, "utf8");
	return parseTodoContent(content, idFallback);
}

async function writeTodoFile(filePath: string, todo: TodoRecord) {
	await fs.writeFile(filePath, serializeTodo(todo), "utf8");
}

async function generateTodoId(todosDir: string): Promise<string> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const id = crypto.randomBytes(4).toString("hex");
		const todoPath = getTodoPath(todosDir, id);
		if (!existsSync(todoPath)) return id;
	}
	throw new Error("Failed to generate unique todo id");
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		return JSON.parse(raw) as LockInfo;
	} catch {
		return null;
	}
}

async function acquireLock(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
): Promise<(() => Promise<void>) | { error: string }> {
	const lockPath = getLockPath(todosDir, id);
	const now = Date.now();
	const session = ctx.sessionManager.getSessionFile();

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await fs.open(lockPath, "wx");
			const info: LockInfo = {
				id,
				pid: process.pid,
				session,
				created_at: new Date(now).toISOString(),
			};
			await handle.writeFile(JSON.stringify(info, null, 2), "utf8");
			await handle.close();
			return async () => {
				try {
					await fs.unlink(lockPath);
				} catch {
					// ignore
				}
			};
		} catch (error: any) {
			if (error?.code !== "EEXIST") {
				return { error: `Failed to acquire lock: ${error?.message ?? "unknown error"}` };
			}
			const stats = await fs.stat(lockPath).catch(() => null);
			const lockAge = stats ? now - stats.mtimeMs : LOCK_TTL_MS + 1;
			if (lockAge <= LOCK_TTL_MS) {
				const info = await readLockInfo(lockPath);
				const owner = info?.session ? ` (session ${info.session})` : "";
				return { error: `Todo ${displayTodoId(id)} is locked${owner}. Try again later.` };
			}
			if (!ctx.hasUI) {
				return { error: `Todo ${displayTodoId(id)} lock is stale; rerun in interactive mode to steal it.` };
			}
			const ok = await ctx.ui.confirm(
				"Todo locked",
				`Todo ${displayTodoId(id)} appears locked. Steal the lock?`,
			);
			if (!ok) {
				return { error: `Todo ${displayTodoId(id)} remains locked.` };
			}
			await fs.unlink(lockPath).catch(() => undefined);
		}
	}

	return { error: `Failed to acquire lock for todo ${displayTodoId(id)}.` };
}

async function withTodoLock<T>(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	fn: () => Promise<T>,
): Promise<T | { error: string }> {
	const lock = await acquireLock(todosDir, id, ctx);
	if (typeof lock === "object" && "error" in lock) return lock;
	try {
		return await fn();
	} finally {
		await lock();
	}
}

async function listTodos(todosDir: string): Promise<TodoFrontMatter[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(todosDir);
	} catch {
		return [];
	}

	const todos: TodoFrontMatter[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const id = entry.slice(0, -3);
		const filePath = path.join(todosDir, entry);
		try {
			const [content, stats] = await Promise.all([
				fs.readFile(filePath, "utf8"),
				fs.stat(filePath),
			]);
			const { frontMatter } = splitFrontMatter(content);
			const parsed = parseFrontMatter(frontMatter, id);
			todos.push({
				id,
				title: parsed.title,
				tags: parsed.tags ?? [],
				status: parsed.status,
				created_at: parsed.created_at,
				updated_at: parsed.updated_at || stats.mtime.toISOString(),
				group_colour: parsed.group_colour,
				assigned_to_session: parsed.assigned_to_session,
				last_worked_at: parsed.last_worked_at,
				last_worked_by_session: parsed.last_worked_by_session,
			});
		} catch {
			// ignore unreadable todo
		}
	}

	return sortTodos(todos);
}

async function listTodoRecords(todosDir: string): Promise<TodoRecord[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(todosDir);
	} catch {
		return [];
	}

	const todos: TodoRecord[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const id = entry.slice(0, -3);
		const filePath = path.join(todosDir, entry);
		try {
			const [content, stats] = await Promise.all([
				fs.readFile(filePath, "utf8"),
				fs.stat(filePath),
			]);
			const todo = parseTodoContent(content, id);
			if (!todo.updated_at) todo.updated_at = stats.mtime.toISOString();
			todos.push(todo);
		} catch {
			// ignore unreadable todo
		}
	}

	return sortTodos(todos) as TodoRecord[];
}

function getTodoIndexPath(todosDir: string): string {
	return path.join(todosDir, TODO_INDEX_NAME);
}

function todoActivityTimestamp(todo: TodoFrontMatter): string {
	return todo.last_worked_at || todo.updated_at || todo.created_at || "";
}

function compareTodoActivityDesc(a: TodoFrontMatter, b: TodoFrontMatter): number {
	return todoActivityTimestamp(b).localeCompare(todoActivityTimestamp(a));
}

function pushUnique(items: string[], id: string): void {
	if (!items.includes(id)) items.push(id);
}

function pushRelationshipEdge(edges: TodoRelationshipEdge[], edge: TodoRelationshipEdge): void {
	if (edge.from === edge.to) return;
	const exists = edges.some(
		(existing) =>
			existing.from === edge.from && existing.to === edge.to && existing.kind === edge.kind,
	);
	if (!exists) edges.push(edge);
}

function extractTodoIds(text: string): string[] {
	const ids = new Set<string>();
	const pattern = /(?:TODO-)?([a-f0-9]{8})/gi;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		ids.add(match[1].toLowerCase());
	}
	return [...ids];
}

function relationshipKindsForLine(line: string): TodoRelationshipKind[] {
	const normalized = line.toLowerCase();
	const kinds: TodoRelationshipKind[] = [];
	if (/\bumbrella\b/.test(normalized)) kinds.push("umbrella");
	else if (/\b(parent|parents)\b/.test(normalized)) kinds.push("parent");
	if (/\b(subtask|subtasks)\b/.test(normalized)) kinds.push("subtask");
	else if (/\b(child|children)\b/.test(normalized)) kinds.push("child");
	if (/\b(depends on|dependency|dependencies|blocked by|requires)\b/.test(normalized)) {
		kinds.push("depends_on");
	}
	if (/\b(blocks|blocking)\b/.test(normalized)) kinds.push("blocks");
	if (/\b(related|see also|sibling)\b/.test(normalized)) kinds.push("related_to");
	if (/\b(duplicate|dupe)\b/.test(normalized)) kinds.push("duplicate_of");
	return kinds;
}

function relationshipEdgesForTodo(todo: TodoRecord, knownTodoIds: Set<string>): TodoRelationshipEdge[] {
	const edges: TodoRelationshipEdge[] = [];
	const lines = todo.body.split(/\r?\n/);
	for (const rawLine of lines) {
		const referencedIds = extractTodoIds(rawLine).filter(
			(id) => id !== todo.id && knownTodoIds.has(id),
		);
		if (!referencedIds.length) continue;
		const kinds = relationshipKindsForLine(rawLine);
		const context = rawLine.trim();
		for (const referencedId of referencedIds) {
			if (kinds.length === 0) {
				pushRelationshipEdge(edges, {
					from: todo.id,
					to: referencedId,
					kind: "related_to",
					source: "explicit-reference",
					context,
				});
				continue;
			}
			for (const kind of kinds) {
				if (kind === "parent" || kind === "umbrella") {
					if (kind === "umbrella") {
						pushRelationshipEdge(edges, {
							from: referencedId,
							to: todo.id,
							kind: "umbrella",
							source: "structured-text",
							context,
						});
					}
					pushRelationshipEdge(edges, {
						from: referencedId,
						to: todo.id,
						kind: "parent",
						source: "structured-text",
						context,
					});
					pushRelationshipEdge(edges, {
						from: todo.id,
						to: referencedId,
						kind: "child",
						source: "computed",
						context,
					});
					continue;
				}
				if (kind === "child" || kind === "subtask") {
					if (kind === "subtask") {
						pushRelationshipEdge(edges, {
							from: todo.id,
							to: referencedId,
							kind: "subtask",
							source: "structured-text",
							context,
						});
					}
					pushRelationshipEdge(edges, {
						from: todo.id,
						to: referencedId,
						kind: "parent",
						source: "structured-text",
						context,
					});
					pushRelationshipEdge(edges, {
						from: referencedId,
						to: todo.id,
						kind: "child",
						source: "computed",
						context,
					});
					continue;
				}
				if (kind === "depends_on") {
					pushRelationshipEdge(edges, {
						from: todo.id,
						to: referencedId,
						kind,
						source: "structured-text",
						context,
					});
					pushRelationshipEdge(edges, {
						from: referencedId,
						to: todo.id,
						kind: "blocks",
						source: "computed",
						context,
					});
					continue;
				}
				if (kind === "blocks") {
					pushRelationshipEdge(edges, {
						from: todo.id,
						to: referencedId,
						kind,
						source: "structured-text",
						context,
					});
					pushRelationshipEdge(edges, {
						from: referencedId,
						to: todo.id,
						kind: "depends_on",
						source: "computed",
						context,
					});
					continue;
				}
				pushRelationshipEdge(edges, {
					from: todo.id,
					to: referencedId,
					kind,
					source: "structured-text",
					context,
				});
			}
		}
	}
	return edges;
}

function createEmptyTodoGraphNode(id: string): TodoIndexGraphNode {
	return {
		id,
		parent_ids: [],
		child_ids: [],
		sibling_ids: [],
		depends_on: [],
		blocks: [],
		related_to: [],
		duplicate_of: [],
	};
}

function buildTodoIndex(todos: TodoRecord[]): TodoIndex {
	const knownTodoIds = new Set(todos.map((todo) => todo.id));
	const sortedTodos = [...todos].sort(compareTodoActivityDesc);
	const tagGroups: Record<string, string[]> = {};
	const statusGroups: Record<string, string[]> = {};
	const nodes: Record<string, TodoIndexGraphNode> = {};
	const edges: TodoRelationshipEdge[] = [];

	for (const todo of sortedTodos) {
		nodes[todo.id] = createEmptyTodoGraphNode(todo.id);
		const status = getTodoStatus(todo);
		(statusGroups[status] ??= []).push(todo.id);
		for (const tag of todo.tags.length ? todo.tags : ["untagged"]) {
			(tagGroups[tag] ??= []).push(todo.id);
		}
	}

	for (const todo of todos) {
		for (const edge of relationshipEdgesForTodo(todo, knownTodoIds)) {
			pushRelationshipEdge(edges, edge);
		}
	}

	for (const edge of edges) {
		const fromNode = nodes[edge.from];
		const toNode = nodes[edge.to];
		if (!fromNode || !toNode) continue;
		if (edge.kind === "parent") pushUnique(fromNode.child_ids, edge.to);
		if (edge.kind === "parent") pushUnique(toNode.parent_ids, edge.from);
		if (edge.kind === "child") pushUnique(fromNode.parent_ids, edge.to);
		if (edge.kind === "child") pushUnique(toNode.child_ids, edge.from);
		if (edge.kind === "depends_on") pushUnique(fromNode.depends_on, edge.to);
		if (edge.kind === "blocks") pushUnique(fromNode.blocks, edge.to);
		if (edge.kind === "related_to") pushUnique(fromNode.related_to, edge.to);
		if (edge.kind === "duplicate_of") pushUnique(fromNode.duplicate_of, edge.to);
	}

	for (const node of Object.values(nodes)) {
		for (const parentId of node.parent_ids) {
			const parent = nodes[parentId];
			if (!parent) continue;
			for (const siblingId of parent.child_ids) {
				if (siblingId !== node.id) pushUnique(node.sibling_ids, siblingId);
			}
		}
	}

	const items: TodoIndexItem[] = sortedTodos.map((todo) => ({
		id: todo.id,
		display_id: formatTodoId(todo.id),
		title: todo.title,
		tags: todo.tags,
		status: getTodoStatus(todo),
		created_at: todo.created_at,
		updated_at: todo.updated_at,
		group_colour: todo.group_colour,
		assigned_to_session: todo.assigned_to_session,
		last_worked_at: todo.last_worked_at,
		last_worked_by_session: todo.last_worked_by_session,
		closed: isTodoClosed(getTodoStatus(todo)),
	}));

	return {
		version: 1,
		generated_at: new Date().toISOString(),
		summary: {
			total: todos.length,
			open: todos.filter((todo) => !isTodoClosed(getTodoStatus(todo))).length,
			closed: todos.filter((todo) => isTodoClosed(getTodoStatus(todo))).length,
			visible_default_limit: 10,
		},
		todos: items,
		groups: {
			tags: tagGroups,
			status: statusGroups,
			recently_worked: sortedTodos
				.filter((todo) => Boolean(todo.last_worked_at))
				.map((todo) => todo.id),
		},
		graph: { edges, nodes },
	};
}

async function refreshTodoIndex(todosDir: string): Promise<TodoIndex> {
	await ensureTodosDir(todosDir);
	const todos = await listTodoRecords(todosDir);
	const index = buildTodoIndex(todos);
	await fs.writeFile(getTodoIndexPath(todosDir), `${JSON.stringify(index, null, 2)}\n`, "utf8");
	return index;
}

function listTodosSync(todosDir: string): TodoFrontMatter[] {
	let entries: string[] = [];
	try {
		entries = readdirSync(todosDir);
	} catch {
		return [];
	}

	const todos: TodoFrontMatter[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const id = entry.slice(0, -3);
		const filePath = path.join(todosDir, entry);
		try {
			const content = readFileSync(filePath, "utf8");
			const stats = statSync(filePath);
			const { frontMatter } = splitFrontMatter(content);
			const parsed = parseFrontMatter(frontMatter, id);
			todos.push({
				id,
				title: parsed.title,
				tags: parsed.tags ?? [],
				status: parsed.status,
				created_at: parsed.created_at,
				updated_at: parsed.updated_at || stats.mtime.toISOString(),
				group_colour: parsed.group_colour,
				assigned_to_session: parsed.assigned_to_session,
				last_worked_at: parsed.last_worked_at,
				last_worked_by_session: parsed.last_worked_by_session,
			});
		} catch {
			// ignore
		}
	}

	return sortTodos(todos);
}

function getTodoTitle(todo: TodoFrontMatter): string {
	return todo.title || "(untitled)";
}

function getTodoStatus(todo: TodoFrontMatter): string {
	return todo.status || "open";
}

function formatAssignmentSuffix(todo: TodoFrontMatter): string {
	return todo.assigned_to_session ? ` (assigned: ${todo.assigned_to_session})` : "";
}

function renderAssignmentSuffix(
	theme: Theme,
	todo: TodoFrontMatter,
	currentSessionId?: string,
): string {
	if (!todo.assigned_to_session) return "";
	const isCurrent = todo.assigned_to_session === currentSessionId;
	const color = isCurrent ? "success" : "dim";
	const suffix = isCurrent ? ", current" : "";
	return theme.fg(color, ` (assigned: ${todo.assigned_to_session}${suffix})`);
}

function formatTodoHeading(todo: TodoFrontMatter): string {
	const tagText = todo.tags.length ? ` [${todo.tags.join(", ")}]` : "";
	return `${formatTodoId(todo.id)} ${getTodoTitle(todo)}${tagText}${formatAssignmentSuffix(todo)}`;
}

function buildRefinePrompt(todoId: string, title: string): string {
	return (
		`let's refine task ${formatTodoId(todoId)} "${title}": ` +
		"Ask me for the missing details needed to refine the todo together. Do not rewrite the todo yet and do not make assumptions. " +
		"Ask clear, concrete questions and wait for my answers before drafting any structured description.\n\n"
	);
}

function splitTodosByAssignment(todos: TodoFrontMatter[]): {
	assignedTodos: TodoFrontMatter[];
	openTodos: TodoFrontMatter[];
	closedTodos: TodoFrontMatter[];
} {
	const assignedTodos: TodoFrontMatter[] = [];
	const openTodos: TodoFrontMatter[] = [];
	const closedTodos: TodoFrontMatter[] = [];
	for (const todo of todos) {
		if (isTodoClosed(getTodoStatus(todo))) {
			closedTodos.push(todo);
			continue;
		}
		if (todo.assigned_to_session) {
			assignedTodos.push(todo);
		} else {
			openTodos.push(todo);
		}
	}
	return { assignedTodos, openTodos, closedTodos };
}

function formatTodoList(todos: TodoFrontMatter[]): string {
	if (!todos.length) return "No todos.";

	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const lines: string[] = [];
	const pushSection = (label: string, sectionTodos: TodoFrontMatter[]) => {
		lines.push(`${label} (${sectionTodos.length}):`);
		if (!sectionTodos.length) {
			lines.push("  none");
			return;
		}
		for (const todo of sectionTodos) {
			lines.push(`  ${formatTodoHeading(todo)}`);
		}
	};

	pushSection("Assigned todos", assignedTodos);
	pushSection("Open todos", openTodos);
	pushSection("Closed todos", closedTodos);
	return lines.join("\n");
}

function serializeTodoForAgent(todo: TodoRecord): string {
	const payload = { ...todo, id: formatTodoId(todo.id) };
	return JSON.stringify(payload, null, 2);
}

function serializeTodoListForAgent(todos: TodoFrontMatter[]): string {
	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const mapTodo = (todo: TodoFrontMatter) => ({ ...todo, id: formatTodoId(todo.id) });
	return JSON.stringify(
		{
			assigned: assignedTodos.map(mapTodo),
			open: openTodos.map(mapTodo),
			closed: closedTodos.map(mapTodo),
		},
		null,
		2,
	);
}

function renderTodoHeading(theme: Theme, todo: TodoFrontMatter, currentSessionId?: string): string {
	const closed = isTodoClosed(getTodoStatus(todo));
	const titleColor = closed ? "dim" : "text";
	const tagText = todo.tags.length ? theme.fg("dim", ` [${todo.tags.join(", ")}]`) : "";
	const assignmentText = renderAssignmentSuffix(theme, todo, currentSessionId);
	return (
		theme.fg("accent", formatTodoId(todo.id)) +
		" " +
		theme.fg(titleColor, getTodoTitle(todo)) +
		tagText +
		assignmentText
	);
}

function renderTodoList(
	theme: Theme,
	todos: TodoFrontMatter[],
	expanded: boolean,
	currentSessionId?: string,
): string {
	if (!todos.length) return theme.fg("dim", "No todos");

	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const lines: string[] = [];
	const pushSection = (label: string, sectionTodos: TodoFrontMatter[]) => {
		lines.push(theme.fg("muted", `${label} (${sectionTodos.length})`));
		if (!sectionTodos.length) {
			lines.push(theme.fg("dim", "  none"));
			return;
		}
		const maxItems = expanded ? sectionTodos.length : Math.min(sectionTodos.length, 3);
		for (let i = 0; i < maxItems; i++) {
			lines.push(`  ${renderTodoHeading(theme, sectionTodos[i], currentSessionId)}`);
		}
		if (!expanded && sectionTodos.length > maxItems) {
			lines.push(theme.fg("dim", `  ... ${sectionTodos.length - maxItems} more`));
		}
	};

	const sections: Array<{ label: string; todos: TodoFrontMatter[] }> = [
		{ label: "Assigned todos", todos: assignedTodos },
		{ label: "Open todos", todos: openTodos },
		{ label: "Closed todos", todos: closedTodos },
	];

	sections.forEach((section, index) => {
		if (index > 0) lines.push("");
		pushSection(section.label, section.todos);
	});

	return lines.join("\n");
}

function renderTodoDetail(theme: Theme, todo: TodoRecord, expanded: boolean): string {
	const summary = renderTodoHeading(theme, todo);
	if (!expanded) return summary;

	const tags = todo.tags.length ? todo.tags.join(", ") : "none";
	const createdAt = todo.created_at || "unknown";
	const bodyText = todo.body?.trim() ? todo.body.trim() : "No details yet.";
	const bodyLines = bodyText.split("\n");

	const lines = [
		summary,
		theme.fg("muted", `Status: ${getTodoStatus(todo)}`),
		theme.fg("muted", `Tags: ${tags}`),
		theme.fg("muted", `Created: ${createdAt}`),
		theme.fg("muted", `Updated: ${todo.updated_at || "unknown"}`),
		...(todo.last_worked_at ? [theme.fg("muted", `Last worked: ${todo.last_worked_at}`)] : []),
		"",
		theme.fg("muted", "Body:"),
		...bodyLines.map((line) => theme.fg("text", `  ${line}`)),
	];

	return lines.join("\n");
}

function appendExpandHint(theme: Theme, text: string): string {
	return `${text}\n${theme.fg("dim", "(expand for more)")}`;
}

function truncatePlainText(text: string, maxLength: number): string {
	const trimmed = text.trim().replace(/\s+/g, " ");
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function todoSnippet(todo: TodoRecord, maxLength = 72): string {
	const firstLine = todo.body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (firstLine) return truncatePlainText(firstLine, maxLength);
	if (todo.tags.length) return truncatePlainText(`tags: ${todo.tags.join(", ")}`, maxLength);
	return "No details yet";
}

function formatTodoAssignmentLabel(todo: TodoFrontMatter, currentSessionId?: string): string | null {
	if (!todo.assigned_to_session) return null;
	if (todo.assigned_to_session === currentSessionId) return "Assigned to current session";
	return `Assigned to ${todo.assigned_to_session}`;
}

function hashTodoIdToPaletteIndex(id: string, paletteLength: number): number {
	let hash = 0;
	for (const char of id) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
	return Math.abs(hash) % paletteLength;
}

const TODO_GROUP_COLOUR_PALETTE = [
	"#6e8bff",
	"#57b8a5",
	"#b18cff",
	"#d79a52",
	"#d36a8f",
	"#7aa66a",
];
const TODO_LEAF_COLOUR = "#5f6874";

function todoGroupColourForRoot(todo: TodoRecord): string {
	return normalizeTodoGroupColour(todo.group_colour)
		?? TODO_GROUP_COLOUR_PALETTE[hashTodoIdToPaletteIndex(todo.id, TODO_GROUP_COLOUR_PALETTE.length)];
}

function todoSidebarStatusWithAccent(status: string, colour: string, meta?: string): string {
	return `${status}|accent:${colour}${meta ? `|meta:${meta}` : ""}`;
}

function todoSidebarChildStatus(status: string, colour: string, meta?: string): string {
	return `${todoSidebarStatusWithAccent(status, colour, meta)}|level:1`;
}

function todoSidebarTagsLine(todo: TodoFrontMatter): string {
	return todo.tags.length ? todo.tags.map((tag) => `#${tag}`).join("  ") : "no tags";
}

function todoSidebarChildCountLabel(childCount: number): string | undefined {
	if (childCount <= 0) return undefined;
	return `${childCount} child todo${childCount === 1 ? "" : "s"}`;
}

function todoIndexRootId(index: TodoIndex, todoId: string): string | null {
	let current = normalizeTodoId(todoId);
	const visited = new Set<string>();
	while (current && !visited.has(current)) {
		visited.add(current);
		const node = index.graph.nodes[current];
		if (!node) return null;
		const parentId = node.parent_ids[0];
		if (!parentId) return current;
		current = parentId;
	}
	return current || null;
}

function buildTodoSidebarDetailLines(
	todo: TodoRecord,
	currentSessionId?: string,
	maxBodyLines = 10,
): string[] {
	const lines = [
		formatTodoId(todo.id),
		`Title: ${todo.title || "(untitled)"}`,
		`Status: ${getTodoStatus(todo)}`,
		`Tags: ${todo.tags.length ? todo.tags.join(", ") : "none"}`,
		`Created: ${todo.created_at || "unknown"}`,
		`Updated: ${todo.updated_at || "unknown"}`,
	];
	if (todo.last_worked_at) {
		lines.push(`Last worked: ${todo.last_worked_at}`);
	}
	const assignment = formatTodoAssignmentLabel(todo, currentSessionId);
	if (assignment) lines.push(assignment);
	lines.push("");
	const bodyText = todo.body?.trim() ? todo.body.trim() : "No details yet.";
	for (const line of formatTodoMarkdownBodyLines(bodyText).slice(0, maxBodyLines)) {
		lines.push(line);
	}
	return lines;
}

function todoClipboardId(todo: TodoFrontMatter): string {
	return formatTodoId(todo.id);
}

function formatTodoMarkdownBodyLines(markdown: string): string[] {
	const lines = markdown.split(/\r?\n/);
	let inCodeBlock = false;
	return lines.map((rawLine) => {
		const line = rawLine.replace(/\s+$/, "");
		const trimmed = line.trim();
		if (trimmed.startsWith("```")) {
			inCodeBlock = !inCodeBlock;
			return inCodeBlock ? "┌─ code" : "└─";
		}
		if (inCodeBlock) return `│ ${line}`;
		const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
		if (heading) {
			const level = heading[1].length;
			const marker = level <= 2 ? "▸" : "•";
			return `${marker} ${heading[2]}`;
		}
		const task = /^[-*]\s+\[([ xX])]\s+(.*)$/.exec(trimmed);
		if (task) return `${task[1].trim().toLowerCase() === "x" ? "☑" : "☐"} ${task[2]}`;
		const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
		if (bullet) return `• ${bullet[1]}`;
		const numbered = /^(\d+)\.\s+(.*)$/.exec(trimmed);
		if (numbered) return `${numbered[1]}. ${numbered[2]}`;
		return line;
	});
}

function buildTodoSidebarFullDetailLines(todo: TodoRecord, currentSessionId?: string): string[] {
	const lines = buildTodoSidebarDetailLines(todo, currentSessionId, 0).slice(0, -1);
	const bodyText = todo.body?.trim() ? todo.body.trim() : "No details yet.";
	lines.push("");
	lines.push(...formatTodoMarkdownBodyLines(bodyText));
	return lines;
}

function buildTodoSidebarSurface(
	todos: TodoRecord[],
	selectedTodo: TodoRecord | null,
	search: string,
	currentSessionId?: string,
	options?: { expanded?: boolean; expandedRootIds?: ReadonlySet<string>; collapsedRootIds?: ReadonlySet<string> },
) {
	const expanded = options?.expanded ?? false;
	const expandedRootIds = options?.expandedRootIds;
	const collapsedRootIds = options?.collapsedRootIds;
	const openTodos = todos.filter((todo) => !isTodoClosed(getTodoStatus(todo)));
	const assignedTodos = openTodos.filter((todo) => Boolean(todo.assigned_to_session));
	const index = buildTodoIndex(openTodos);
	const todoById = new Map(openTodos.map((todo) => [todo.id, todo] as const));
	const recentlyWorkedRootIds = index.groups.recently_worked
		.map((id) => index.graph.nodes[id]?.parent_ids[0] ?? id)
		.filter((id) => todoById.has(id))
		.filter((id, position, ids) => ids.indexOf(id) === position);
	const detailTodo = selectedTodo && !isTodoClosed(getTodoStatus(selectedTodo))
		? selectedTodo
		: openTodos[0] ?? todos[0] ?? null;
	const selectedRootId = detailTodo
		? index.graph.nodes[detailTodo.id]?.parent_ids[0] ?? detailTodo.id
		: null;

	const buildListItems = (items: TodoRecord[]) =>
		items.map((todo) => ({
			id: todo.id,
			title: `${formatTodoId(todo.id)} ${todo.title || "(untitled)"}`,
			subtitle: todoSidebarTagsLine(todo),
			status: todoSidebarStatusWithAccent(getTodoStatus(todo), normalizeTodoGroupColour(todo.group_colour) ?? TODO_LEAF_COLOUR),
		}));

	const buildTreeItems = () => {
		const rootIds = Object.values(index.graph.nodes)
			.filter((node) => node.parent_ids.length === 0 && todoById.has(node.id))
			.map((node) => node.id)
			.sort((a, b) => compareTodoActivityDesc(todoById.get(a)!, todoById.get(b)!));
		const orderedRootIds = [
			...recentlyWorkedRootIds.filter((id) => rootIds.includes(id)),
			...rootIds.filter((id) => !recentlyWorkedRootIds.includes(id)),
		];
		const items: Array<{ id: string; title: string; subtitle: string; status: string }> = [];
		const maxVisible = expanded ? Number.POSITIVE_INFINITY : 10;

		for (const rootId of orderedRootIds) {
			const root = todoById.get(rootId);
			const node = index.graph.nodes[rootId];
			if (!root || !node) continue;
			const collapsedRoot = collapsedRootIds?.has(rootId) ?? false;
			const expandedRoot = !collapsedRoot && (expanded || expandedRootIds?.has(rootId) || rootId === selectedRootId);
			const visibleChildIds = node.child_ids.filter((childId) => todoById.has(childId));
			const childCount = visibleChildIds.length;
			const groupColour = childCount ? todoGroupColourForRoot(root) : TODO_LEAF_COLOUR;
			items.push({
				id: root.id,
				title: `${expandedRoot ? "▾" : "▸"} ${formatTodoId(root.id)} ${root.title || "(untitled)"}`,
				subtitle: todoSidebarTagsLine(root),
				status: todoSidebarStatusWithAccent(getTodoStatus(root), groupColour, todoSidebarChildCountLabel(childCount)),
			});
			if (expandedRoot) {
				const childIds = visibleChildIds.sort((a, b) =>
					compareTodoActivityDesc(todoById.get(a)!, todoById.get(b)!),
				);
				for (const childId of childIds) {
					const child = todoById.get(childId);
					if (!child) continue;
					items.push({
						id: child.id,
						title: `    ↳ ${formatTodoId(child.id)} ${child.title || "(untitled)"}`,
						subtitle: todoSidebarTagsLine(child),
						status: todoSidebarChildStatus(getTodoStatus(child), groupColour),
					});
				}
			}
			if (items.length >= maxVisible) break;
		}
		return items.slice(0, maxVisible);
	};

	const sections: Array<Record<string, unknown>> = [
		{
			kind: "summary",
			title: "Overview",
			items: [
				{ label: "Open", value: String(openTodos.length) },
				{ label: "Assigned", value: String(assignedTodos.length) },
				{ label: "Closed", value: String(todos.length - openTodos.length) },
				{ label: "Filter", value: search.trim() || "none" },
			],
		},
	];

	if (search.trim()) {
		sections.push({
			kind: "list",
			id: "todo-search-results",
			label: "Filtered todos",
			items: buildListItems(todos),
			selected_id: detailTodo?.id,
		});
	} else {
		sections.push({
			kind: "list",
			id: "todo-tree-list",
			label: expanded ? "Todo tree" : "Recent todo tree",
			items: buildTreeItems(),
			selected_id: detailTodo?.id,
		});
	}

	return {
		id: "pi-todos-sidebar",
		title: "Todos",
		sections,
	};
}

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function defaultMpmuxSocketPath(): string {
	const explicit = process.env[MPMUX_SOCKET_ENV];
	if (explicit && explicit.trim().length > 0) return expandHome(stripAtPrefix(explicit.trim()));

	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	if (runtimeDir && runtimeDir.trim().length > 0) {
		return path.join(runtimeDir, MPMUX_DEFAULT_SOCKET_NAME);
	}

	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid !== undefined) {
		const runUser = path.join("/run/user", String(uid));
		if (existsSync(runUser)) {
			return path.join(runUser, MPMUX_DEFAULT_SOCKET_NAME);
		}
		return path.join("/tmp", `mpmux-${uid}`, MPMUX_DEFAULT_SOCKET_NAME);
	}

	return path.join(os.tmpdir(), MPMUX_DEFAULT_SOCKET_NAME);
}

function createMpmuxHostClientId(): string {
	return `pi-todos-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function sendMpmuxHostRequest(
	socketPath: string,
	command: string,
	fields: Record<string, unknown>,
	timeoutMs = MPMUX_HOST_TIMEOUT_MS,
): Promise<unknown> {
	const request = JSON.stringify({ id: `pi-todos-${Date.now()}`, command, ...fields }) + "\n";

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

		client.on("connect", () => {
			client.write(request);
		});

		client.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			const line = buffer.slice(0, newlineIndex).trim();
			if (!line) {
				finish(() => reject(new Error("Received an empty response line from the mpmux host socket.")));
				return;
			}
			try {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				if (parsed.status === "error") {
					const message = typeof parsed.message === "string" ? parsed.message : `Host command failed: ${command}`;
					finish(() => reject(new Error(message)));
					return;
				}
				if (parsed.status === "ok") {
					finish(() => resolve(parsed.data));
					return;
				}
				finish(() => resolve(parsed));
			} catch (error) {
				finish(() => reject(error instanceof Error ? error : new Error(String(error))));
			}
		});

		client.on("error", (error) => {
			finish(() => reject(error));
		});

		client.on("end", () => {
			if (settled) return;
			finish(() => reject(new Error("Connection closed before a host response was received.")));
		});
	});
}

async function ensureMpmuxHostAttached(state: MpmuxHostSidebarState): Promise<void> {
	if (state.attached) return;
	await sendMpmuxHostRequest(state.socketPath, "attach", {
		client_id: state.clientId,
		target_client_id: state.clientId,
		name: "Pi todos sidebar",
		role: "controller",
	});
	state.attached = true;
}

async function withMpmuxHostControl<T>(
	state: MpmuxHostSidebarState,
	fn: () => Promise<T>,
): Promise<T> {
	await ensureMpmuxHostAttached(state);
	await sendMpmuxHostRequest(state.socketPath, "acquire-control", {
		client_id: state.clientId,
		target_client_id: state.clientId,
	});
	try {
		return await fn();
	} finally {
		await sendMpmuxHostRequest(state.socketPath, "release-control", {
			client_id: state.clientId,
			target_client_id: state.clientId,
		}).catch(() => undefined);
	}
}

async function showMpmuxTodoSidebar(
	state: MpmuxHostSidebarState,
	sidebar: ReturnType<typeof buildTodoSidebarSurface>,
): Promise<void> {
	await withMpmuxHostControl(state, async () => {
		await sendMpmuxHostRequest(state.socketPath, "show-custom-sidebar", {
			client_id: state.clientId,
			sidebar,
		});
	});
}

async function clearMpmuxTodoSidebar(state: MpmuxHostSidebarState): Promise<void> {
	await withMpmuxHostControl(state, async () => {
		await sendMpmuxHostRequest(state.socketPath, "clear-custom-sidebar", {
			client_id: state.clientId,
		});
	});
}

async function showMpmuxTodoDialog(
	state: MpmuxHostSidebarState,
	dialog: Record<string, unknown>,
): Promise<void> {
	await withMpmuxHostControl(state, async () => {
		await sendMpmuxHostRequest(state.socketPath, "show-custom-dialog", {
			client_id: state.clientId,
			dialog,
		});
	});
}

async function clearMpmuxTodoDialog(state: MpmuxHostSidebarState): Promise<void> {
	await withMpmuxHostControl(state, async () => {
		await sendMpmuxHostRequest(state.socketPath, "clear-custom-dialog", {
			client_id: state.clientId,
		});
	});
}

async function subscribeMpmuxTodoHostEvents(state: MpmuxHostSidebarState): Promise<void> {
	await ensureMpmuxHostAttached(state);
	await sendMpmuxHostRequest(state.socketPath, "subscribe", {
		client_id: state.clientId,
		events: ["ui-state-changed", "custom-dialog-state-changed", "custom-sidebar-state-changed"],
	});
}

async function pollMpmuxTodoHostEvents(state: MpmuxHostSidebarState): Promise<MpmuxHostPollEventsResponse> {
	await ensureMpmuxHostAttached(state);
	return (await sendMpmuxHostRequest(state.socketPath, "poll-events", {
		client_id: state.clientId,
		max_events: 8,
	})) as MpmuxHostPollEventsResponse;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function showMpmuxTodoUiState(state: MpmuxHostSidebarState): Promise<MpmuxUiState> {
	await ensureMpmuxHostAttached(state);
	return (await sendMpmuxHostRequest(state.socketPath, "show-ui-state", {
		client_id: state.clientId,
	})) as MpmuxUiState;
}

function isMpmuxWaitTimeout(error: unknown): boolean {
	return error instanceof Error && /timed out waiting for mpmux host response/i.test(error.message);
}

function isMpmuxOverlayAlreadyActiveError(error: unknown): boolean {
	return error instanceof Error && /another overlay is already active/i.test(error.message);
}

function useExpandedTodoSidebarLayout(uiState: MpmuxUiState | null): boolean {
	if (!uiState) return false;
	if (uiState.message_sidebar.maximize_mode) return true;
	return (uiState.message_sidebar.visible_width_px ?? 0) >= 700;
}

function buildTodoSidebarDialogSurface(todo: TodoRecord, currentSessionId?: string) {
	const assignedToCurrentSession = todo.assigned_to_session === currentSessionId;
	const claimLabel = todo.assigned_to_session
		? assignedToCurrentSession
			? "Release"
			: "Force Claim"
		: "Claim";
	const closeLabel = isTodoClosed(getTodoStatus(todo)) ? "Reopen ticket" : "Close ticket";
	return {
		id: `todo-actions-${todo.id}`,
		title: `${formatTodoId(todo.id)} ${todo.title || "(untitled)"}`,
		subtitle: "Choose an action",
		width: "wide",
		dismissable: true,
		submit_on_enter: true,
		sections: [
			{
				kind: "detail",
				id: "todo-details",
				title: "Todo details",
				lines: buildTodoSidebarFullDetailLines(todo, currentSessionId),
			},
		],
		footer: {
			primary: { id: "work", label: "Work on", style: "primary" },
			secondary: [
				{ id: "refine", label: "Refine" },
				{ id: "claim-toggle", label: claimLabel },
				{ id: "status-toggle", label: closeLabel },
			],
		},
	};
}

async function cleanupMpmuxHostSidebarState(state: MpmuxHostSidebarState): Promise<void> {
	if (!state.attached) return;
	await sendMpmuxHostRequest(state.socketPath, "detach", {
		client_id: state.clientId,
		target_client_id: state.clientId,
	}).catch(() => undefined);
	state.attached = false;
}

async function ensureTodoExists(filePath: string, id: string): Promise<TodoRecord | null> {
	if (!existsSync(filePath)) return null;
	return readTodoFile(filePath, id);
}

async function appendTodoBody(filePath: string, todo: TodoRecord, text: string): Promise<TodoRecord> {
	const spacer = todo.body.trim().length ? "\n\n" : "";
	todo.body = `${todo.body.replace(/\s+$/, "")}${spacer}${text.trim()}\n`;
	markTodoUpdated(todo);
	await writeTodoFile(filePath, todo);
	return todo;
}

async function updateTodoStatus(
	todosDir: string,
	id: string,
	status: string,
	ctx: ExtensionContext,
): Promise<TodoRecord | { error: string }> {
	const validated = validateTodoId(id);
	if ("error" in validated) {
		return { error: validated.error };
	}
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) {
		return { error: `Todo ${displayTodoId(id)} not found` };
	}

	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
		existing.status = status;
		markTodoUpdated(existing);
		clearAssignmentIfClosed(existing);
		await writeTodoFile(filePath, existing);
		return existing;
	});

	if (typeof result === "object" && "error" in result) {
		return { error: result.error };
	}

	return result;
}

async function claimTodoAssignment(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	force = false,
): Promise<TodoRecord | { error: string }> {
	const validated = validateTodoId(id);
	if ("error" in validated) {
		return { error: validated.error };
	}
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) {
		return { error: `Todo ${displayTodoId(id)} not found` };
	}
	const sessionId = ctx.sessionManager.getSessionId();
	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
		if (isTodoClosed(existing.status)) {
			return { error: `Todo ${displayTodoId(id)} is closed` } as const;
		}
		const assigned = existing.assigned_to_session;
		if (assigned && assigned !== sessionId && !force) {
			return {
				error: `Todo ${displayTodoId(id)} is already assigned to session ${assigned}. Use force to override.`,
			} as const;
		}
		markTodoWorked(existing, sessionId);
		if (assigned !== sessionId) {
			existing.assigned_to_session = sessionId;
		}
		await writeTodoFile(filePath, existing);
		return existing;
	});

	if (typeof result === "object" && "error" in result) {
		return { error: result.error };
	}

	return result;
}

async function releaseTodoAssignment(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	force = false,
): Promise<TodoRecord | { error: string }> {
	const validated = validateTodoId(id);
	if ("error" in validated) {
		return { error: validated.error };
	}
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) {
		return { error: `Todo ${displayTodoId(id)} not found` };
	}
	const sessionId = ctx.sessionManager.getSessionId();
	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
		const assigned = existing.assigned_to_session;
		if (!assigned) {
			return existing;
		}
		if (assigned !== sessionId && !force) {
			return {
				error: `Todo ${displayTodoId(id)} is assigned to session ${assigned}. Use force to release.`,
			} as const;
		}
		existing.assigned_to_session = undefined;
		await writeTodoFile(filePath, existing);
		return existing;
	});

	if (typeof result === "object" && "error" in result) {
		return { error: result.error };
	}

	return result;
}

async function deleteTodo(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
): Promise<TodoRecord | { error: string }> {
	const validated = validateTodoId(id);
	if ("error" in validated) {
		return { error: validated.error };
	}
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) {
		return { error: `Todo ${displayTodoId(id)} not found` };
	}

	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
		await fs.unlink(filePath);
		return existing;
	});

	if (typeof result === "object" && "error" in result) {
		return { error: result.error };
	}

	return result;
}

export default function todosExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const todosDir = getTodosDir(ctx.cwd);
		await ensureTodosDir(todosDir);
		const settings = await readTodoSettings(todosDir);
		await garbageCollectTodos(todosDir, settings);
	});

	const todosDirLabel = getTodosDirLabel(process.cwd());
	const hostSidebarClients = new Map<string, MpmuxHostSidebarState>();
	let activeTodoSidebarRun: { controller: AbortController; promise: Promise<void> } | null = null;
	const todoSidebarAbortReasons = new WeakMap<AbortSignal, "replace" | "clear" | "shutdown">();

	function abortActiveTodoSidebar(reason: "replace" | "clear" | "shutdown"): Promise<void> | null {
		if (!activeTodoSidebarRun) return null;
		todoSidebarAbortReasons.set(activeTodoSidebarRun.controller.signal, reason);
		activeTodoSidebarRun.controller.abort();
		return activeTodoSidebarRun.promise;
	}

	function getHostSidebarState(socketPath = defaultMpmuxSocketPath()): MpmuxHostSidebarState {
		let state = hostSidebarClients.get(socketPath);
		if (!state) {
			state = {
				socketPath,
				clientId: createMpmuxHostClientId(),
				attached: false,
			};
			hostSidebarClients.set(socketPath, state);
		}
		return state;
	}

	pi.on("session_shutdown", async () => {
		abortActiveTodoSidebar("shutdown");
		for (const state of hostSidebarClients.values()) {
			await cleanupMpmuxHostSidebarState(state);
		}
		hostSidebarClients.clear();
	});

	function workPromptForTodo(todo: TodoFrontMatter): string {
		return `work on todo ${formatTodoId(todo.id)} "${todo.title || "(untitled)"}"`;
	}

	function submitTodoActionPrompt(prompt: string, ctx: ExtensionContext): void {
		try {
			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				ctx.ui.notify("Todo action queued as follow-up", "info");
			}
		} catch (error) {
			ctx.ui.setEditorText(prompt);
			ctx.ui.notify(
				`Todo action could not auto-submit; inserted it into the editor instead: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	function selectedTodoFromId(todos: TodoRecord[], selectedTodoId: string | null): TodoRecord | null {
		if (selectedTodoId) {
			const exact = todos.find((todo) => todo.id === normalizeTodoId(selectedTodoId));
			if (exact) return exact;
		}
		return todos.find((todo) => !isTodoClosed(getTodoStatus(todo))) ?? todos[0] ?? null;
	}

	async function runTodoSidebarHostUi(args: string, ctx: ExtensionCommandContext, signal?: AbortSignal): Promise<void> {
		const trimmedArgs = (args ?? "").trim();
		if (!ctx.hasUI) {
			console.log("/todos-sidebar requires the Pi UI and an mpmux host session.");
			return;
		}

		const todosDir = getTodosDir(ctx.cwd);
		const state = getHostSidebarState();
		const currentSessionId = ctx.sessionManager.getSessionId();
		let uiState: MpmuxUiState | null = null;
		const initialTodoId = trimmedArgs && !("error" in validateTodoId(trimmedArgs)) ? normalizeTodoId(trimmedArgs) : null;
		const sidebarSearch = trimmedArgs && !initialTodoId ? trimmedArgs : "";
		let selectedTodoId: string | null = initialTodoId;
		const expandedRootIds = new Set<string>();
		const collapsedRootIds = new Set<string>();
		let lastSidebarInteractionNonce = 0;
		let lastDialogActionNonce = 0;
		let nextPrompt: string | null = null;
		let keepRunning = !signal?.aborted;
		let sidebarDirty = false;
		let todosWatcher: FSWatcher | null = null;

		const refreshSidebar = async () => {
			const todos = await listTodoRecords(todosDir);
			const visibleTodos = sidebarSearch ? filterTodos(todos, sidebarSearch) as TodoRecord[] : todos;
			const selectedTodo = selectedTodoFromId(visibleTodos, selectedTodoId);
			selectedTodoId = selectedTodo?.id ?? null;
			await showMpmuxTodoSidebar(
				state,
				buildTodoSidebarSurface(visibleTodos, selectedTodo, sidebarSearch, currentSessionId, {
					expanded: useExpandedTodoSidebarLayout(uiState),
					expandedRootIds,
					collapsedRootIds,
				}),
			);
		};

		const toggleTodoTreeRoot = async (todoId: string, options: { collapseOnly?: boolean; expandOnly?: boolean } = {}): Promise<boolean> => {
			const todos = await listTodoRecords(todosDir);
			const visibleTodos = sidebarSearch ? filterTodos(todos, sidebarSearch) as TodoRecord[] : todos;
			const index = buildTodoIndex(
				visibleTodos.filter((todo) => !isTodoClosed(getTodoStatus(todo))),
			);
			const normalized = normalizeTodoId(todoId);
			const rootId = todoIndexRootId(index, normalized);
			if (!rootId) return false;
			const rootNode = index.graph.nodes[rootId];
			if (!rootNode || rootNode.child_ids.length === 0) return false;
			const selectedRootId = selectedTodoId ? todoIndexRootId(index, selectedTodoId) : null;
			const effectivelyExpanded = !collapsedRootIds.has(rootId)
				&& (expandedRootIds.has(rootId) || selectedRootId === rootId || useExpandedTodoSidebarLayout(uiState));
			if (effectivelyExpanded) {
				if (options.expandOnly) return false;
				expandedRootIds.delete(rootId);
				collapsedRootIds.add(rootId);
			} else {
				if (options.collapseOnly) return false;
				collapsedRootIds.delete(rootId);
				expandedRootIds.add(rootId);
			}
			selectedTodoId = rootId;
			await refreshSidebar();
			return true;
		};

		const openSelectedTodoDialog = async (todoId: string) => {
			const todos = await listTodoRecords(todosDir);
			const todo = todos.find((item) => item.id === normalizeTodoId(todoId));
			if (!todo) {
				ctx.ui.notify(`Todo ${displayTodoId(todoId)} not found`, "error");
				await refreshSidebar();
				return;
			}
			selectedTodoId = todo.id;
			if (uiState?.custom_dialog?.open) {
				return;
			}
			try {
				await showMpmuxTodoDialog(state, buildTodoSidebarDialogSurface(todo, currentSessionId));
			} catch (error) {
				if (isMpmuxOverlayAlreadyActiveError(error)) {
					uiState = await showMpmuxTodoUiState(state).catch(() => uiState);
					return;
				}
				throw error;
			}
		};

		const copySelectedTodoReference = async (todoId: string) => {
			const todos = await listTodoRecords(todosDir);
			const todo = todos.find((item) => item.id === normalizeTodoId(todoId));
			if (!todo) {
				ctx.ui.notify(`Todo ${displayTodoId(todoId)} not found`, "error");
				await refreshSidebar();
				return;
			}
			selectedTodoId = todo.id;
			const label = todoClipboardId(todo);
			try {
				await copyToClipboard(label);
				ctx.ui.notify(`Copied ${label}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		};

		const applyDialogAction = async (actionId: string) => {
			if (!selectedTodoId) return;
			const todo = (await listTodoRecords(todosDir)).find((item) => item.id === selectedTodoId);
			if (!todo) {
				ctx.ui.notify(`Todo ${displayTodoId(selectedTodoId)} not found`, "error");
				await refreshSidebar();
				return;
			}

			switch (actionId) {
				case "work": {
					nextPrompt = workPromptForTodo(todo);
					keepRunning = false;
					return;
				}
				case "refine": {
					nextPrompt = buildRefinePrompt(todo.id, todo.title || "(untitled)");
					keepRunning = false;
					return;
				}
				case "claim-toggle": {
					const result = !todo.assigned_to_session
						? await claimTodoAssignment(todosDir, todo.id, ctx, false)
						: todo.assigned_to_session === currentSessionId
							? await releaseTodoAssignment(todosDir, todo.id, ctx, false)
							: await claimTodoAssignment(todosDir, todo.id, ctx, true);
					if ("error" in result) {
						ctx.ui.notify(result.error, "error");
					} else {
						ctx.ui.notify(
							todo.assigned_to_session === currentSessionId
								? `Released ${formatTodoId(todo.id)}`
								: `Claimed ${formatTodoId(todo.id)}`,
							"info",
						);
					}
					await refreshSidebar();
					return;
				}
				case "status-toggle": {
					const nextStatus = isTodoClosed(getTodoStatus(todo)) ? "open" : "closed";
					const result = await updateTodoStatus(todosDir, todo.id, nextStatus, ctx);
					if ("error" in result) {
						ctx.ui.notify(result.error, "error");
					} else {
						ctx.ui.notify(
							nextStatus === "closed"
								? `Closed ${formatTodoId(todo.id)}`
								: `Reopened ${formatTodoId(todo.id)}`,
							"info",
						);
					}
					await refreshSidebar();
					return;
				}
			}
		};

		try {
			await ensureTodosDir(todosDir);
			todosWatcher = watch(todosDir, (eventType, filename) => {
				if (eventType === "rename" || (typeof filename === "string" && filename.endsWith(".md"))) {
					sidebarDirty = true;
				}
			});
			await ensureMpmuxHostAttached(state);
			await subscribeMpmuxTodoHostEvents(state);
			uiState = await showMpmuxTodoUiState(state);
			await refreshSidebar();

			while (keepRunning && !signal?.aborted) {
				let response: MpmuxHostPollEventsResponse;
				try {
					response = await pollMpmuxTodoHostEvents(state);
				} catch (error) {
					if (isMpmuxWaitTimeout(error)) {
						await sleep(250);
						continue;
					}
					throw error;
				}

				if (response.events.length === 0) {
					if (sidebarDirty) {
						sidebarDirty = false;
						await refreshSidebar();
						continue;
					}
					// `wait-for-events` is the preferred shape, but this command runs inside Pi
					// and must not leave a host-control bridge request blocked behind a long wait.
					// Polling is local to the visible sidebar lifecycle and every poll returns
					// immediately, keeping the shared host-control socket responsive.
					await sleep(250);
					continue;
				}

				for (const event of response.events) {
					if (event.ui_state) {
						const nextExpanded = useExpandedTodoSidebarLayout(event.ui_state);
						const prevExpanded = useExpandedTodoSidebarLayout(uiState);
						uiState = event.ui_state;
						if (nextExpanded !== prevExpanded) {
							await refreshSidebar();
						}
					}

					if (event.custom_sidebar) {
						if (!event.custom_sidebar.open) {
							keepRunning = false;
							break;
						}
						if (event.custom_sidebar.selected_item_id) {
							// The host already moves the visible highlight locally for ArrowUp/ArrowDown.
							// Do not echo every selection change back through show-custom-sidebar: doing so
							// rebuilds the whole sidebar, resets scroll targets, and makes cursor navigation
							// visibly jump. Keep only the logical selection here; refresh on structural
							// changes such as expand/collapse, file updates, layout changes, and actions.
							selectedTodoId = normalizeTodoId(event.custom_sidebar.selected_item_id);
						}
						const interaction = event.custom_sidebar.last_interaction;
						if (
							interaction &&
							interaction.nonce > lastSidebarInteractionNonce
						) {
							lastSidebarInteractionNonce = interaction.nonce;
							if (interaction.kind === "item-invoked" && interaction.item_id) {
								const source = interaction.source ?? "keyboard";
								if (source === "pointer") {
									await toggleTodoTreeRoot(interaction.item_id);
									continue;
								}
								if (source === "arrow-left") {
									await toggleTodoTreeRoot(interaction.item_id, { collapseOnly: true });
									continue;
								}
								if (source === "arrow-right") {
									await toggleTodoTreeRoot(interaction.item_id, { expandOnly: true });
									continue;
								}
								if (source === "copy") {
									await copySelectedTodoReference(interaction.item_id);
									continue;
								}
								await openSelectedTodoDialog(interaction.item_id);
							}
						}
					}

					if (event.custom_dialog?.last_action) {
						const action = event.custom_dialog.last_action;
						if (action.nonce > lastDialogActionNonce) {
							lastDialogActionNonce = action.nonce;
							await applyDialogAction(action.result.action_id);
						}
					}
				}
			}
		} catch (error) {
			ctx.ui.notify(
				`mpmux todo sidebar unavailable: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		} finally {
			todosWatcher?.close();
			const abortReason = signal ? todoSidebarAbortReasons.get(signal) : undefined;
			if (abortReason !== "replace") {
				await clearMpmuxTodoDialog(state).catch(() => undefined);
				await clearMpmuxTodoSidebar(state).catch(() => undefined);
				await cleanupMpmuxHostSidebarState(state).catch(() => undefined);
			}
		}

		if (nextPrompt) {
			submitTodoActionPrompt(nextPrompt, ctx);
		}
	}

	async function runTodoManager(
		args: string,
		ctx: ExtensionCommandContext,
		options: { syncHostSidebar: boolean },
	) {
		const todosDir = getTodosDir(ctx.cwd);
		let todoRecords = await listTodoRecords(todosDir);
		const currentSessionId = ctx.sessionManager.getSessionId();
		const searchTerm = (args ?? "").trim();

		if (!ctx.hasUI) {
			console.log(formatTodoList(todoRecords));
			return;
		}

		const recordCache = new Map(todoRecords.map((todo) => [todo.id, todo] as const));
		const hostSidebarState = options.syncHostSidebar ? getHostSidebarState() : null;
		let hostSidebarUnavailable = false;
		let keepHostSidebarOpen = false;
		let nextPrompt: string | null = null;
		let rootTui: TUI | null = null;

		const syncHostSidebar = async (
			selectedTodo: TodoFrontMatter | null,
			state: { search: string; filteredTodos: TodoFrontMatter[] },
		) => {
			if (!hostSidebarState || hostSidebarUnavailable) return;
			try {
				const selectedRecord = selectedTodo ? recordCache.get(selectedTodo.id) ?? null : null;
				const filteredRecords = state.filteredTodos
					.map((todo) => recordCache.get(todo.id))
					.filter((todo): todo is TodoRecord => Boolean(todo));
				await showMpmuxTodoSidebar(
					hostSidebarState,
					buildTodoSidebarSurface(filteredRecords, selectedRecord, state.search, currentSessionId),
				);
			} catch (error) {
				hostSidebarUnavailable = true;
				ctx.ui.notify(
					`mpmux sidebar unavailable: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		};

		await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			rootTui = tui;
			let selector: TodoSelectorComponent | null = null;
			let actionMenu: TodoActionMenuComponent | null = null;
			let deleteConfirm: TodoDeleteConfirmComponent | null = null;
			let activeComponent:
				| {
						render: (width: number) => string[];
						invalidate: () => void;
						handleInput?: (data: string) => void;
						focused?: boolean;
				  }
				| null = null;
			let wrapperFocused = false;

			const setActiveComponent = (
				component:
					| {
							render: (width: number) => string[];
							invalidate: () => void;
							handleInput?: (data: string) => void;
							focused?: boolean;
					  }
					| null,
			) => {
				if (activeComponent && "focused" in activeComponent) {
					activeComponent.focused = false;
				}
				activeComponent = component;
				if (activeComponent && "focused" in activeComponent) {
					activeComponent.focused = wrapperFocused;
				}
				tui.requestRender();
			};

			const copyTodoPathToClipboard = (todoId: string) => {
				const filePath = getTodoPath(todosDir, todoId);
				const absolutePath = path.resolve(filePath);
				try {
					copyToClipboard(absolutePath);
					ctx.ui.notify(`Copied ${absolutePath} to clipboard`, "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(message, "error");
				}
			};

			const copyTodoTextToClipboard = (record: TodoRecord) => {
				const title = record.title || "(untitled)";
				const body = record.body?.trim() || "";
				const text = body ? `# ${title}\n\n${body}` : `# ${title}`;
				try {
					copyToClipboard(text);
					ctx.ui.notify("Copied todo text to clipboard", "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(message, "error");
				}
			};

			const resolveTodoRecord = async (todo: TodoFrontMatter): Promise<TodoRecord | null> => {
				const cached = recordCache.get(todo.id);
				if (cached) return cached;
				const filePath = getTodoPath(todosDir, todo.id);
				const record = await ensureTodoExists(filePath, todo.id);
				if (!record) {
					ctx.ui.notify(`Todo ${formatTodoId(todo.id)} not found`, "error");
					return null;
				}
				recordCache.set(record.id, record);
				return record;
			};

			const refreshTodoRecords = async () => {
				todoRecords = await listTodoRecords(todosDir);
				recordCache.clear();
				for (const todo of todoRecords) recordCache.set(todo.id, todo);
				selector?.setTodos(todoRecords);
			};

			const openTodoOverlay = async (record: TodoRecord): Promise<TodoOverlayAction> => {
				const action = await ctx.ui.custom<TodoOverlayAction>(
					(overlayTui, overlayTheme, overlayKeybindings, overlayDone) =>
						new TodoDetailOverlayComponent(
							overlayTui,
							overlayTheme,
							overlayKeybindings,
							record,
							overlayDone,
						),
					{
						overlay: true,
						overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" },
					},
				);

				return action ?? "back";
			};

			const applyTodoAction = async (
				record: TodoRecord,
				action: TodoMenuAction,
			): Promise<"stay" | "exit"> => {
				if (action === "refine") {
					keepHostSidebarOpen = true;
					nextPrompt = buildRefinePrompt(record.id, record.title || "(untitled)");
					done();
					return "exit";
				}
				if (action === "work") {
					keepHostSidebarOpen = true;
					nextPrompt = `work on todo ${formatTodoId(record.id)} "${record.title || "(untitled)"}"`;
					done();
					return "exit";
				}
				if (action === "view") {
					return "stay";
				}
				if (action === "copyPath") {
					copyTodoPathToClipboard(record.id);
					return "stay";
				}
				if (action === "copyText") {
					copyTodoTextToClipboard(record);
					return "stay";
				}

				if (action === "release") {
					const result = await releaseTodoAssignment(todosDir, record.id, ctx, true);
					if ("error" in result) {
						ctx.ui.notify(result.error, "error");
						return "stay";
					}
					await refreshTodoRecords();
					ctx.ui.notify(`Released todo ${formatTodoId(record.id)}`, "info");
					return "stay";
				}

				if (action === "delete") {
					const result = await deleteTodo(todosDir, record.id, ctx);
					if ("error" in result) {
						ctx.ui.notify(result.error, "error");
						return "stay";
					}
					await refreshTodoRecords();
					ctx.ui.notify(`Deleted todo ${formatTodoId(record.id)}`, "info");
					return "stay";
				}

				const nextStatus = action === "close" ? "closed" : "open";
				const result = await updateTodoStatus(todosDir, record.id, nextStatus, ctx);
				if ("error" in result) {
					ctx.ui.notify(result.error, "error");
					return "stay";
				}

				await refreshTodoRecords();
				ctx.ui.notify(
					`${action === "close" ? "Closed" : "Reopened"} todo ${formatTodoId(record.id)}`,
					"info",
				);
				return "stay";
			};

			const handleActionSelection = async (record: TodoRecord, action: TodoMenuAction) => {
				if (action === "view") {
					const overlayAction = await openTodoOverlay(record);
					if (overlayAction === "work") {
						await applyTodoAction(record, "work");
						return;
					}
					if (actionMenu) {
						setActiveComponent(actionMenu);
					}
					return;
				}

				if (action === "delete") {
					const message = `Delete todo ${formatTodoId(record.id)}? This cannot be undone.`;
					deleteConfirm = new TodoDeleteConfirmComponent(theme, message, (confirmed) => {
						if (!confirmed) {
							setActiveComponent(actionMenu);
							return;
						}
						void (async () => {
							await applyTodoAction(record, "delete");
							setActiveComponent(selector);
						})();
					});
					setActiveComponent(deleteConfirm);
					return;
				}

				const result = await applyTodoAction(record, action);
				if (result === "stay") {
					setActiveComponent(selector);
				}
			};

			const showActionMenu = async (todo: TodoFrontMatter | TodoRecord) => {
				const record = "body" in todo ? todo : await resolveTodoRecord(todo);
				if (!record) return;
				actionMenu = new TodoActionMenuComponent(
					theme,
					record,
					(action) => {
						void handleActionSelection(record, action);
					},
					() => {
						setActiveComponent(selector);
					},
				);
				setActiveComponent(actionMenu);
			};

			selector = new TodoSelectorComponent(
				tui,
				theme,
				keybindings,
				todoRecords,
				(todo) => {
					void showActionMenu(todo);
				},
				() => done(),
				searchTerm || undefined,
				currentSessionId,
				(todo, action) => {
					keepHostSidebarOpen = options.syncHostSidebar;
					nextPrompt =
						action === "refine"
							? buildRefinePrompt(todo.id, todo.title || "(untitled)")
							: `work on todo ${formatTodoId(todo.id)} "${todo.title || "(untitled)"}"`;
					done();
				},
				(todo, state) => {
					void syncHostSidebar(todo, state);
				},
			);

			setActiveComponent(selector);

			const rootComponent = {
				get focused() {
					return wrapperFocused;
				},
				set focused(value: boolean) {
					wrapperFocused = value;
					if (activeComponent && "focused" in activeComponent) {
						activeComponent.focused = value;
					}
				},
				render(width: number) {
					return activeComponent ? activeComponent.render(width) : [];
				},
				invalidate() {
					activeComponent?.invalidate();
				},
				handleInput(data: string) {
					activeComponent?.handleInput?.(data);
				},
			};

			return rootComponent;
		});

		if (nextPrompt) {
			submitTodoActionPrompt(nextPrompt, ctx);
			rootTui?.requestRender();
		}

		if (hostSidebarState && !keepHostSidebarOpen && !hostSidebarUnavailable) {
			await clearMpmuxTodoSidebar(hostSidebarState).catch(() => undefined);
		}
	}

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			`Manage file-based todos in ${todosDirLabel} (list, list-all, get, create, update, append, delete, claim, release, refresh-index). ` +
			"Title is the short summary; body is long-form markdown notes (update replaces, append adds); group_colour is an optional #rrggbb sidebar accent for parent/group todos. " +
			"Todo ids are shown as TODO-<hex>; id parameters accept TODO-<hex> or the raw hex filename. " +
			"Claim tasks before working on them to avoid conflicts, and close them when complete. " +
			"When creating or updating related work, mention TODO-<hex> references in the body using headings like Parent, Children, Depends on, Blocks, Related, Duplicate of, or Subtasks so in-memory overview/navigation can build relationships; refresh-index only exports a generated debug/index artifact.",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const todosDir = getTodosDir(ctx.cwd);
			const action: TodoAction = params.action;

			switch (action) {
				case "list": {
					const todos = await listTodos(todosDir);
					const { assignedTodos, openTodos } = splitTodosByAssignment(todos);
					const listedTodos = [...assignedTodos, ...openTodos];
					const currentSessionId = ctx.sessionManager.getSessionId();
					return {
						content: [{ type: "text", text: serializeTodoListForAgent(listedTodos) }],
						details: { action: "list", todos: listedTodos, currentSessionId },
					};
				}

				case "list-all": {
					const todos = await listTodos(todosDir);
					const currentSessionId = ctx.sessionManager.getSessionId();
					return {
						content: [{ type: "text", text: serializeTodoListForAgent(todos) }],
						details: { action: "list-all", todos, currentSessionId },
					};
				}

				case "get": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { action: "get", error: "id required" },
						};
					}
					const validated = validateTodoId(params.id);
					if ("error" in validated) {
						return {
							content: [{ type: "text", text: validated.error }],
							details: { action: "get", error: validated.error },
						};
					}
					const normalizedId = validated.id;
					const displayId = formatTodoId(normalizedId);
					const filePath = getTodoPath(todosDir, normalizedId);
					const todo = await ensureTodoExists(filePath, normalizedId);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo ${displayId} not found` }],
							details: { action: "get", error: "not found" },
						};
					}
					return {
						content: [{ type: "text", text: serializeTodoForAgent(todo) }],
						details: { action: "get", todo },
					};
				}

				case "create": {
					if (!params.title) {
						return {
							content: [{ type: "text", text: "Error: title required" }],
							details: { action: "create", error: "title required" },
						};
					}
					await ensureTodosDir(todosDir);
					const id = await generateTodoId(todosDir);
					const filePath = getTodoPath(todosDir, id);
					const now = new Date().toISOString();
					const todo: TodoRecord = {
						id,
						title: params.title,
						tags: params.tags ?? [],
						status: params.status ?? "open",
						created_at: now,
						updated_at: now,
						group_colour: normalizeTodoGroupColour(params.group_colour),
						body: params.body ?? "",
					};

					const result = await withTodoLock(todosDir, id, ctx, async () => {
						await writeTodoFile(filePath, todo);
						return todo;
					});

					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { action: "create", error: result.error },
						};
					}

					return {
						content: [{ type: "text", text: serializeTodoForAgent(todo) }],
						details: { action: "create", todo },
					};
				}

				case "update": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { action: "update", error: "id required" },
						};
					}
					const validated = validateTodoId(params.id);
					if ("error" in validated) {
						return {
							content: [{ type: "text", text: validated.error }],
							details: { action: "update", error: validated.error },
						};
					}
					const normalizedId = validated.id;
					const displayId = formatTodoId(normalizedId);
					const filePath = getTodoPath(todosDir, normalizedId);
					if (!existsSync(filePath)) {
						return {
							content: [{ type: "text", text: `Todo ${displayId} not found` }],
							details: { action: "update", error: "not found" },
						};
					}
					const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
						const existing = await ensureTodoExists(filePath, normalizedId);
						if (!existing) return { error: `Todo ${displayId} not found` } as const;

						existing.id = normalizedId;
						let contentChanged = false;
						if (params.title !== undefined) {
							existing.title = params.title;
							contentChanged = true;
						}
						if (params.status !== undefined) {
							existing.status = params.status;
							contentChanged = true;
						}
						if (params.tags !== undefined) {
							existing.tags = params.tags;
							contentChanged = true;
						}
						if (params.body !== undefined) {
							existing.body = params.body;
							contentChanged = true;
						}
						if (params.group_colour !== undefined) {
							existing.group_colour = normalizeTodoGroupColour(params.group_colour);
							contentChanged = true;
						}
						if (!existing.created_at) existing.created_at = new Date().toISOString();
						if (contentChanged) markTodoUpdated(existing);
						clearAssignmentIfClosed(existing);

						await writeTodoFile(filePath, existing);
						return existing;
					});

					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { action: "update", error: result.error },
						};
					}

					const updatedTodo = result as TodoRecord;
					return {
						content: [{ type: "text", text: serializeTodoForAgent(updatedTodo) }],
						details: { action: "update", todo: updatedTodo },
					};
				}

				case "append": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { action: "append", error: "id required" },
						};
					}
					const validated = validateTodoId(params.id);
					if ("error" in validated) {
						return {
							content: [{ type: "text", text: validated.error }],
							details: { action: "append", error: validated.error },
						};
					}
					const normalizedId = validated.id;
					const displayId = formatTodoId(normalizedId);
					const filePath = getTodoPath(todosDir, normalizedId);
					if (!existsSync(filePath)) {
						return {
							content: [{ type: "text", text: `Todo ${displayId} not found` }],
							details: { action: "append", error: "not found" },
						};
					}
					const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
						const existing = await ensureTodoExists(filePath, normalizedId);
						if (!existing) return { error: `Todo ${displayId} not found` } as const;
						if (!params.body || !params.body.trim()) {
							return existing;
						}
						const updated = await appendTodoBody(filePath, existing, params.body);
						return updated;
					});

					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { action: "append", error: result.error },
						};
					}

					const updatedTodo = result as TodoRecord;
					return {
						content: [{ type: "text", text: serializeTodoForAgent(updatedTodo) }],
						details: { action: "append", todo: updatedTodo },
					};
				}

				case "claim": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { action: "claim", error: "id required" },
						};
					}
					const result = await claimTodoAssignment(
						todosDir,
						params.id,
						ctx,
						Boolean(params.force),
					);
					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { action: "claim", error: result.error },
						};
					}
					const updatedTodo = result as TodoRecord;
					return {
						content: [{ type: "text", text: serializeTodoForAgent(updatedTodo) }],
						details: { action: "claim", todo: updatedTodo },
					};
				}

				case "release": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { action: "release", error: "id required" },
						};
					}
					const result = await releaseTodoAssignment(
						todosDir,
						params.id,
						ctx,
						Boolean(params.force),
					);
					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { action: "release", error: result.error },
						};
					}
					const updatedTodo = result as TodoRecord;
					return {
						content: [{ type: "text", text: serializeTodoForAgent(updatedTodo) }],
						details: { action: "release", todo: updatedTodo },
					};
				}

				case "refresh-index": {
					const index = await refreshTodoIndex(todosDir);
					const indexPath = getTodoIndexPath(todosDir);
					return {
						content: [
							{
								type: "text",
								text: `Refreshed ${indexPath} (${index.summary.open} open, ${index.summary.closed} closed, ${index.graph.edges.length} relationship edges).`,
							},
						],
						details: { action: "refresh-index", index },
					};
				}

				case "delete": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { action: "delete", error: "id required" },
						};
					}

					const validated = validateTodoId(params.id);
					if ("error" in validated) {
						return {
							content: [{ type: "text", text: validated.error }],
							details: { action: "delete", error: validated.error },
						};
					}
					const result = await deleteTodo(todosDir, validated.id, ctx);
					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { action: "delete", error: result.error },
						};
					}

					return {
						content: [{ type: "text", text: serializeTodoForAgent(result as TodoRecord) }],
						details: { action: "delete", todo: result as TodoRecord },
					};
				}
			}
		},


		renderCall(args, theme) {
			const action = typeof args.action === "string" ? args.action : "";
			const id = typeof args.id === "string" ? args.id : "";
			const normalizedId = id ? normalizeTodoId(id) : "";
			const title = typeof args.title === "string" ? args.title : "";
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", action);
			if (normalizedId) {
				text += " " + theme.fg("accent", formatTodoId(normalizedId));
			}
			if (title) {
				text += " " + theme.fg("dim", `"${title}"`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as TodoToolDetails | undefined;
			if (isPartial) {
				return new Text(theme.fg("warning", "Processing..."), 0, 0);
			}
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details.action === "list" || details.action === "list-all") {
				let text = renderTodoList(theme, details.todos, expanded, details.currentSessionId);
				if (!expanded) {
					const { closedTodos } = splitTodosByAssignment(details.todos);
					if (closedTodos.length) {
						text = appendExpandHint(theme, text);
					}
				}
				return new Text(text, 0, 0);
			}

			if (details.action === "refresh-index") {
				const text =
					theme.fg("success", "✓ Refreshed todo index") +
					"\n" +
					theme.fg("muted", `${details.index.summary.open} open • ${details.index.summary.closed} closed • ${details.index.graph.edges.length} edges`);
				return new Text(text, 0, 0);
			}

			if (!("todo" in details)) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			let text = renderTodoDetail(theme, details.todo, expanded);
			const actionLabel =
				details.action === "create"
					? "Created"
					: details.action === "update"
						? "Updated"
						: details.action === "append"
							? "Appended to"
							: details.action === "delete"
								? "Deleted"
								: details.action === "claim"
									? "Claimed"
									: details.action === "release"
										? "Released"
										: null;
			if (actionLabel) {
				const lines = text.split("\n");
				lines[0] = theme.fg("success", "✓ ") + theme.fg("muted", `${actionLabel} `) + lines[0];
				text = lines.join("\n");
			}
			if (!expanded) {
				text = appendExpandHint(theme, text);
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "List todos from .pi/todos",
		handler: async (args, ctx) => {
			await runTodoManager(args, ctx, { syncHostSidebar: false });
		},
	});

	pi.registerCommand("todos-index", {
		description: "Export the optional generated .pi/todos/index.json snapshot",
		handler: async (_args, ctx) => {
			const todosDir = getTodosDir(ctx.cwd);
			try {
				const index = await refreshTodoIndex(todosDir);
				ctx.ui.notify(
					`Refreshed todo index (${index.summary.open} open, ${index.summary.closed} closed, ${index.graph.edges.length} edges).`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Failed to refresh todo index: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	const openTodoSidebarCommand = (args: string, ctx: ExtensionCommandContext) => {
		abortActiveTodoSidebar("replace");
		const controller = new AbortController();
		const promise = runTodoSidebarHostUi(args, ctx, controller.signal).finally(() => {
			if (activeTodoSidebarRun?.controller === controller) {
				activeTodoSidebarRun = null;
			}
		});
		activeTodoSidebarRun = { controller, promise };
		ctx.ui.notify("Opened the mpmux todo sidebar.", "info");
	};

	pi.registerCommand("todos-sidebar", {
		description: "Open the standalone mpmux-hosted todo sidebar UI",
		handler: async (args, ctx) => {
			if ((args ?? "").trim() === "--clear") {
				abortActiveTodoSidebar("clear");
				const state = getHostSidebarState();
				try {
					await clearMpmuxTodoDialog(state).catch(() => undefined);
					await clearMpmuxTodoSidebar(state);
					ctx.ui.notify("Cleared the mpmux todo sidebar.", "info");
				} catch (error) {
					ctx.ui.notify(
						`Failed to clear the mpmux todo sidebar: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				return;
			}

			openTodoSidebarCommand(args, ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+shift+t", {
		description: "Open the mpmux todo sidebar",
		handler: async (ctx) => {
			openTodoSidebarCommand("", ctx as ExtensionCommandContext);
		},
	});

}
