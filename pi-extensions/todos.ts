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
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import { existsSync } from "node:fs";
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
} from "@earendil-works/pi-tui";
import {
	TodoFrontMatter,
	TodoRecord,
	KeybindingMatcher,
	TodoSelectionChangeCallback,
	MpmuxHostSidebarState,
	TodoAction,
	TodoOverlayAction,
	TodoMenuAction,
	TodoToolDetails,
	formatTodoId,
	normalizeTodoId,
	validateTodoId,
	isTodoClosed,
	clearAssignmentIfClosed,
	buildTodoSearchText,
	getTodosDir,
	getTodosDirLabel,
	readTodoSettings,
	garbageCollectTodos,
	getTodoPath,
	normalizeTodoGroupColour,
	markTodoUpdated,
	ensureTodosDir,
	writeTodoFile,
	generateTodoId,
	withTodoLock,
	listTodos,
	listTodoRecords,
	getTodoIndexPath,
	refreshTodoIndex,
	getTodoTitle,
	getTodoStatus,
	buildRefinePrompt,
	splitTodosByAssignment,
	formatTodoList,
	serializeTodoForAgent,
	serializeTodoListForAgent,
	buildTodoSidebarSurface,
	defaultMpmuxSocketPath,
	createMpmuxHostClientId,
	showMpmuxTodoSidebar,
	clearMpmuxTodoSidebar,
	clearMpmuxTodoDialog,
	cleanupMpmuxHostSidebarState,
	ensureTodoExists,
	appendTodoBody,
	updateTodoStatus,
	claimTodoAssignment,
	releaseTodoAssignment,
	deleteTodo,
	runTodoSidebarHostUi as runTodoSidebarHostUiCore,
} from "../lib/todos-core.ts";

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

	function submitTodoActionPrompt(prompt: string, ctx: ExtensionContext): void {
		try {
			pi.sendUserMessage(prompt);
			ctx.ui.notify("Todo action sent", "info");
			return;
		} catch (immediateError) {
			try {
				pi.sendUserMessage(prompt, { deliverAs: "steer" });
				ctx.ui.notify("Todo action queued for the active turn", "info");
				return;
			} catch (queuedError) {
				ctx.ui.setEditorText(prompt);
				ctx.ui.notify(
					`Todo action could not auto-submit; inserted it into the editor instead: ${queuedError instanceof Error ? queuedError.message : immediateError instanceof Error ? immediateError.message : String(queuedError)}`,
					"warning",
				);
			}
		}
	}

	async function runTodoSidebarHostUi(args: string, ctx: ExtensionCommandContext, signal?: AbortSignal): Promise<void> {
		if (!ctx.hasUI) {
			console.log("/todos-sidebar requires the Pi UI and an mpmux host session.");
			return;
		}
		await runTodoSidebarHostUiCore(
			args,
			{
				cwd: ctx.cwd,
				ctx,
				notify: (message, level) => ctx.ui.notify(message, level),
				submitPrompt: (prompt) => submitTodoActionPrompt(prompt, ctx),
				copyText: (text) => copyToClipboard(text),
			},
			getHostSidebarState(),
			{ signal, abortReason: () => (signal ? todoSidebarAbortReasons.get(signal) : undefined) },
		);
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
		if (activeTodoSidebarRun && !activeTodoSidebarRun.controller.signal.aborted) {
			ctx.ui.notify(
				"The mpmux todo sidebar is already running. Use /todos-sidebar --clear before reopening it.",
				"info",
			);
			return;
		}
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
