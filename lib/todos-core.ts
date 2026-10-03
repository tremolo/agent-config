/**
 * Agent-independent todo storage and mpmux todo sidebar logic.
 *
 * Shared by the Pi `todos` extension and the standalone `mpmux-todos-sidebar`
 * runner (Claude Code and other terminal agents). Nothing here imports Pi
 * packages; agent-specific behavior comes in through `TodoAgentContext` and
 * `TodoSidebarAgent`.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";

/** The parts of an agent session the todo storage needs (locks, assignment). */
export type TodoAgentContext = {
	hasUI: boolean;
	sessionManager: {
		getSessionId(): string;
		getSessionFile(): string | undefined;
	};
	ui: {
		confirm(title: string, message: string): Promise<boolean>;
	};
};

export const TODO_DIR_NAME = ".pi/todos";
export const TODO_PATH_ENV = "PI_TODO_PATH";
export const TODO_SETTINGS_NAME = "settings.json";
export const TODO_INDEX_NAME = "index.json";
export const TODO_ID_PREFIX = "TODO-";
export const TODO_ID_PATTERN = /^[a-f0-9]{8}$/i;
export const DEFAULT_TODO_SETTINGS = {
	gc: true,
	gcDays: 7,
};
export const LOCK_TTL_MS = 30 * 60 * 1000;
export const MPMUX_SOCKET_ENV = "MPMUX_SOCKET_PATH";
export const MPMUX_HOST_CONTROL_TCP_ENV = "MPMUX_HOST_CONTROL_TCP";
export const MPMUX_DEFAULT_SOCKET_NAME = "mpmux.sock";
export const MPMUX_HOST_TIMEOUT_MS = 5_000;
export const MPMUX_HOST_PROTOCOL_VERSION = 23;
export const TODO_SIDEBAR_REFRESH_ITEM_ID = "__todo-sidebar-refresh";

export interface TodoSidebarFilterState {
	query: string;
}

export interface TodoFrontMatter {
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

export interface TodoRecord extends TodoFrontMatter {
	body: string;
}

export interface LockInfo {
	id: string;
	pid: number;
	session?: string | null;
	created_at: string;
}

export interface TodoSettings {
	gc: boolean;
	gcDays: number;
}

export type TodoRelationshipKind =
	| "parent"
	| "child"
	| "depends_on"
	| "blocks"
	| "related_to"
	| "duplicate_of"
	| "umbrella"
	| "subtask";

export type TodoRelationshipEdge = {
	from: string;
	to: string;
	kind: TodoRelationshipKind;
	source: "structured-text" | "explicit-reference" | "computed";
	context?: string;
};

export type TodoIndexItem = TodoFrontMatter & {
	display_id: string;
	closed: boolean;
};

export type TodoIndexGraphNode = {
	id: string;
	parent_ids: string[];
	child_ids: string[];
	sibling_ids: string[];
	depends_on: string[];
	blocks: string[];
	related_to: string[];
	duplicate_of: string[];
};

export type TodoIndex = {
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

export type KeybindingMatcher = {
	matches: (keyData: string, keybindingId: string) => boolean;
};

export type TodoSelectionChangeCallback = (
	todo: TodoFrontMatter | null,
	state: { search: string; filteredTodos: TodoFrontMatter[] },
) => void;

export type MpmuxHostSidebarState = {
	socketPath: string;
	clientId: string;
	attached: boolean;
	/** Name shown in mpmux's client list; defaults to the Pi sidebar. */
	clientName?: string;
};

export type MpmuxHostEventKind =
	| "control-owner-changed"
	| "ui-state-changed"
	| "dialog-state-changed"
	| "custom-dialog-state-changed"
	| "custom-sidebar-state-changed";

export type MpmuxCustomSidebarInteraction = {
	nonce: number;
	kind: "selection-changed" | "item-invoked" | "filter-changed";
	source?: string;
	section_id?: string;
	item_id?: string;
	value?: string;
};

export type MpmuxCustomSidebarState = {
	open: boolean;
	id?: string;
	title?: string;
	section_count: number;
	rendered_text?: string;
	selected_item_id?: string;
	filter_query?: string;
	last_interaction?: MpmuxCustomSidebarInteraction;
};

export type MpmuxCustomDialogActionEvent = {
	nonce: number;
	result: {
		dialog_id: string;
		action_id: string;
		submitted: boolean;
		values: Array<{ field_id: string; value: unknown }>;
	};
};

export type MpmuxCustomDialogState = {
	open: boolean;
	id?: string;
	title?: string;
	last_action?: MpmuxCustomDialogActionEvent;
};

export type MpmuxUiState = {
	message_sidebar: {
		open: boolean;
		maximize_mode: boolean;
		visible_width_px?: number;
	};
	custom_sidebar: MpmuxCustomSidebarState;
	custom_dialog: MpmuxCustomDialogState;
};

export type MpmuxHostEvent = {
	kind: MpmuxHostEventKind;
	ui_state?: MpmuxUiState;
	custom_sidebar?: MpmuxCustomSidebarState;
	custom_dialog?: MpmuxCustomDialogState;
};

export type MpmuxHostPollEventsResponse = {
	client_id: string;
	events: MpmuxHostEvent[];
	pending_event_count: number;
};

export type TodoAction =
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

export type TodoOverlayAction = "back" | "work";

export type TodoMenuAction =
	| "work"
	| "refine"
	| "close"
	| "reopen"
	| "release"
	| "delete"
	| "copyPath"
	| "copyText"
	| "view";

export type TodoToolDetails =
	| { action: "list" | "list-all"; todos: TodoFrontMatter[]; currentSessionId?: string; error?: string }
	| { action: "refresh-index"; index: TodoIndex; error?: string }
	| {
			action: "get" | "create" | "update" | "append" | "delete" | "claim" | "release";
			todo: TodoRecord;
			error?: string;
		};

export function formatTodoId(id: string): string {
	return `${TODO_ID_PREFIX}${id}`;
}

export function normalizeTodoId(id: string): string {
	let trimmed = id.trim();
	if (trimmed.startsWith("#")) {
		trimmed = trimmed.slice(1);
	}
	if (trimmed.toUpperCase().startsWith(TODO_ID_PREFIX)) {
		trimmed = trimmed.slice(TODO_ID_PREFIX.length);
	}
	return trimmed;
}

export function validateTodoId(id: string): { id: string } | { error: string } {
	const normalized = normalizeTodoId(id);
	if (!normalized || !TODO_ID_PATTERN.test(normalized)) {
		return { error: "Invalid todo id. Expected TODO-<hex>." };
	}
	return { id: normalized.toLowerCase() };
}

export function displayTodoId(id: string): string {
	return formatTodoId(normalizeTodoId(id));
}

export function isTodoClosed(status: string): boolean {
	return ["closed", "done"].includes(status.toLowerCase());
}

export function clearAssignmentIfClosed(todo: TodoFrontMatter): void {
	if (isTodoClosed(getTodoStatus(todo))) {
		todo.assigned_to_session = undefined;
	}
}

export function sortTodos(todos: TodoFrontMatter[]): TodoFrontMatter[] {
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

export function buildTodoSearchText(todo: TodoFrontMatter): string {
	const tags = todo.tags.join(" ");
	const assignment = todo.assigned_to_session ? `assigned:${todo.assigned_to_session}` : "";
	const workedBy = todo.last_worked_by_session ? `worked:${todo.last_worked_by_session}` : "";
	return `${formatTodoId(todo.id)} ${todo.id} ${todo.title} ${tags} ${todo.status} ${assignment} ${workedBy} ${todo.updated_at ?? ""}`.trim();
}

export function todoHasOpenDescendant(
	todo: TodoRecord,
	index: TodoIndex,
	todoById: ReadonlyMap<string, TodoRecord>,
	visited = new Set<string>(),
): boolean {
	if (visited.has(todo.id)) return false;
	visited.add(todo.id);
	const childIds = index.graph.nodes[todo.id]?.child_ids ?? [];
	for (const childId of childIds) {
		const child = todoById.get(childId);
		if (!child) continue;
		if (!isTodoClosed(getTodoStatus(child)) || todoHasOpenDescendant(child, index, todoById, visited)) {
			return true;
		}
	}
	return false;
}

export function todoStatusWithOpenDescendants(todo: TodoRecord, index: TodoIndex, todoById: ReadonlyMap<string, TodoRecord>): string {
	const status = getTodoStatus(todo);
	if (isTodoClosed(status) && todoHasOpenDescendant(todo, index, todoById)) {
		return "open";
	}
	return status;
}

export function todoSidebarCountsLabel(todos: TodoRecord[]): string {
	const index = buildTodoIndex(todos);
	const todoById = new Map(todos.map((todo) => [todo.id, todo] as const));
	const closed = todos.filter((todo) => isTodoClosed(todoStatusWithOpenDescendants(todo, index, todoById))).length;
	const assigned = todos.filter((todo) => !isTodoClosed(todoStatusWithOpenDescendants(todo, index, todoById)) && Boolean(todo.assigned_to_session)).length;
	return `Open ${todos.length - closed} • Assigned ${assigned} • Closed ${closed}`;
}

export function splitTodoSidebarFilterQuery(query: string): { text: string; tags: string[] } {
	const textTokens: string[] = [];
	const tags: string[] = [];
	for (const token of query.split(/\s+/).map((part) => part.trim()).filter(Boolean)) {
		if (token.startsWith("#") && token.length > 1) {
			tags.push(token.slice(1).toLowerCase());
		} else {
			textTokens.push(token);
		}
	}
	return { text: textTokens.join(" "), tags };
}

export function todoSidebarTextMatches(todo: TodoRecord, text: string): boolean {
	const tokens = text
		.toLowerCase()
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);
	if (tokens.length === 0) return true;

	const searchable = `${formatTodoId(todo.id)} ${todo.id} ${todo.title}`.toLowerCase();
	return tokens.every((token) => searchable.includes(token));
}

export function todoMatchesSidebarFilter(todo: TodoRecord, filter: TodoSidebarFilterState): boolean {
	const { text, tags } = splitTodoSidebarFilterQuery(filter.query);
	if (tags.length && !tags.every((tag) => todo.tags.some((candidate) => candidate.toLowerCase() === tag))) {
		return false;
	}
	return todoSidebarTextMatches(todo, text);
}

export function filterTodosForSidebar(todos: TodoRecord[], filter: TodoSidebarFilterState): TodoRecord[] {
	const index = buildTodoIndex(todos);
	const todoById = new Map(todos.map((todo) => [todo.id, todo] as const));
	const matchingOpenTodos = todos.filter((todo) => !isTodoClosed(todoStatusWithOpenDescendants(todo, index, todoById)) && todoMatchesSidebarFilter(todo, filter));
	const matchingOpenIds = new Set(matchingOpenTodos.map((todo) => todo.id));
	const visibleIds = new Set(matchingOpenIds);
	for (const todo of matchingOpenTodos) {
		for (const parentId of index.graph.nodes[todo.id]?.parent_ids ?? []) {
			visibleIds.add(parentId);
		}
	}
	return todos.filter((todo) => visibleIds.has(todo.id));
}

export function isTodoSidebarActionItemId(itemId: string): boolean {
	return itemId === TODO_SIDEBAR_REFRESH_ITEM_ID;
}


export function getTodosDir(cwd: string): string {
	const overridePath = process.env[TODO_PATH_ENV];
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	return path.resolve(cwd, TODO_DIR_NAME);
}

export function getTodosDirLabel(cwd: string): string {
	const overridePath = process.env[TODO_PATH_ENV];
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	return TODO_DIR_NAME;
}

export function getTodoSettingsPath(todosDir: string): string {
	return path.join(todosDir, TODO_SETTINGS_NAME);
}

export function normalizeTodoSettings(raw: Partial<TodoSettings>): TodoSettings {
	const gc = raw.gc ?? DEFAULT_TODO_SETTINGS.gc;
	const gcDays = Number.isFinite(raw.gcDays) ? raw.gcDays : DEFAULT_TODO_SETTINGS.gcDays;
	return {
		gc: Boolean(gc),
		gcDays: Math.max(0, Math.floor(gcDays)),
	};
}

export async function readTodoSettings(todosDir: string): Promise<TodoSettings> {
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

export async function garbageCollectTodos(todosDir: string, settings: TodoSettings): Promise<void> {
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

export function getTodoPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.md`);
}

export function getLockPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.lock`);
}

export function normalizeTodoGroupColour(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	const match = /^#?([0-9a-f]{6})$/i.exec(trimmed);
	return match ? `#${match[1].toLowerCase()}` : undefined;
}

export function parseFrontMatter(text: string, idFallback: string): TodoFrontMatter {
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

export function findJsonObjectEnd(content: string): number {
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

export function splitFrontMatter(content: string): { frontMatter: string; body: string } {
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

export function parseTodoContent(content: string, idFallback: string): TodoRecord {
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

export function markTodoUpdated(todo: TodoRecord, timestamp = new Date().toISOString()): void {
	todo.updated_at = timestamp;
}

export function markTodoWorked(todo: TodoRecord, sessionId: string, timestamp = new Date().toISOString()): void {
	todo.last_worked_at = timestamp;
	todo.last_worked_by_session = sessionId;
}

export function serializeTodo(todo: TodoRecord): string {
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

export async function ensureTodosDir(todosDir: string) {
	await fs.mkdir(todosDir, { recursive: true });
}

export async function readTodoFile(filePath: string, idFallback: string): Promise<TodoRecord> {
	const content = await fs.readFile(filePath, "utf8");
	return parseTodoContent(content, idFallback);
}

export async function writeTodoFile(filePath: string, todo: TodoRecord) {
	await fs.writeFile(filePath, serializeTodo(todo), "utf8");
}

export async function generateTodoId(todosDir: string): Promise<string> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const id = crypto.randomBytes(4).toString("hex");
		const todoPath = getTodoPath(todosDir, id);
		if (!existsSync(todoPath)) return id;
	}
	throw new Error("Failed to generate unique todo id");
}

export async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		return JSON.parse(raw) as LockInfo;
	} catch {
		return null;
	}
}

export async function acquireLock(
	todosDir: string,
	id: string,
	ctx: TodoAgentContext,
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

export async function withTodoLock<T>(
	todosDir: string,
	id: string,
	ctx: TodoAgentContext,
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

export async function listTodos(todosDir: string): Promise<TodoFrontMatter[]> {
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

export async function listTodoRecords(todosDir: string): Promise<TodoRecord[]> {
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

export function getTodoIndexPath(todosDir: string): string {
	return path.join(todosDir, TODO_INDEX_NAME);
}

export function todoActivityTimestamp(todo: TodoFrontMatter): string {
	return todo.last_worked_at || todo.updated_at || todo.created_at || "";
}

export function compareTodoActivityDesc(a: TodoFrontMatter, b: TodoFrontMatter): number {
	return todoActivityTimestamp(b).localeCompare(todoActivityTimestamp(a));
}

export function pushUnique(items: string[], id: string): void {
	if (!items.includes(id)) items.push(id);
}

export function pushRelationshipEdge(edges: TodoRelationshipEdge[], edge: TodoRelationshipEdge): void {
	if (edge.from === edge.to) return;
	const exists = edges.some(
		(existing) =>
			existing.from === edge.from && existing.to === edge.to && existing.kind === edge.kind,
	);
	if (!exists) edges.push(edge);
}

export function extractTodoIds(text: string): string[] {
	const ids = new Set<string>();
	const pattern = /(?:TODO-)?([a-f0-9]{8})/gi;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		ids.add(match[1].toLowerCase());
	}
	return [...ids];
}

export function relationshipKindsForLine(line: string): TodoRelationshipKind[] {
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

export function relationshipEdgesForTodo(todo: TodoRecord, knownTodoIds: Set<string>): TodoRelationshipEdge[] {
	const edges: TodoRelationshipEdge[] = [];
	const lines = todo.body.split(/\r?\n/);
	let sectionKinds: TodoRelationshipKind[] = [];
	for (const rawLine of lines) {
		const lineKinds = relationshipKindsForLine(rawLine);
		if (/^#{1,6}\s+/.test(rawLine)) {
			sectionKinds = lineKinds;
		}
		const referencedIds = extractTodoIds(rawLine).filter(
			(id) => id !== todo.id && knownTodoIds.has(id),
		);
		if (!referencedIds.length) continue;
		const kinds = lineKinds.length ? lineKinds : sectionKinds;
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

export function createEmptyTodoGraphNode(id: string): TodoIndexGraphNode {
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

export function buildTodoIndex(todos: TodoRecord[]): TodoIndex {
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

export async function refreshTodoIndex(todosDir: string): Promise<TodoIndex> {
	await ensureTodosDir(todosDir);
	const todos = await listTodoRecords(todosDir);
	const index = buildTodoIndex(todos);
	await fs.writeFile(getTodoIndexPath(todosDir), `${JSON.stringify(index, null, 2)}\n`, "utf8");
	return index;
}

export function listTodosSync(todosDir: string): TodoFrontMatter[] {
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

export function getTodoTitle(todo: TodoFrontMatter): string {
	return todo.title || "(untitled)";
}

export function getTodoStatus(todo: TodoFrontMatter): string {
	return todo.status || "open";
}

export function formatAssignmentSuffix(todo: TodoFrontMatter): string {
	return todo.assigned_to_session ? ` (assigned: ${todo.assigned_to_session})` : "";
}

export function formatTodoHeading(todo: TodoFrontMatter): string {
	const tagText = todo.tags.length ? ` [${todo.tags.join(", ")}]` : "";
	return `${formatTodoId(todo.id)} ${getTodoTitle(todo)}${tagText}${formatAssignmentSuffix(todo)}`;
}

export function buildRefinePrompt(todoId: string, title: string): string {
	return (
		`let's refine task ${formatTodoId(todoId)} "${title}": ` +
		"Ask me for the missing details needed to refine the todo together. Do not rewrite the todo yet and do not make assumptions. " +
		"Ask clear, concrete questions and wait for my answers before drafting any structured description.\n\n"
	);
}

export function splitTodosByAssignment(todos: TodoFrontMatter[]): {
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

export function formatTodoList(todos: TodoFrontMatter[]): string {
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

export function serializeTodoForAgent(todo: TodoRecord): string {
	const payload = { ...todo, id: formatTodoId(todo.id) };
	return JSON.stringify(payload, null, 2);
}

export function serializeTodoListForAgent(todos: TodoFrontMatter[]): string {
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


export function truncatePlainText(text: string, maxLength: number): string {
	const trimmed = text.trim().replace(/\s+/g, " ");
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function todoSnippet(todo: TodoRecord, maxLength = 72): string {
	const firstLine = todo.body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (firstLine) return truncatePlainText(firstLine, maxLength);
	if (todo.tags.length) return truncatePlainText(`tags: ${todo.tags.join(", ")}`, maxLength);
	return "No details yet";
}

export function formatTodoAssignmentLabel(todo: TodoFrontMatter, currentSessionId?: string): string | null {
	if (!todo.assigned_to_session) return null;
	if (todo.assigned_to_session === currentSessionId) return "Assigned to current session";
	return `Assigned to ${todo.assigned_to_session}`;
}

export function hashTodoIdToPaletteIndex(id: string, paletteLength: number): number {
	let hash = 0;
	for (const char of id) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
	return Math.abs(hash) % paletteLength;
}

export const TODO_GROUP_COLOUR_PALETTE = [
	"#6e8bff",
	"#57b8a5",
	"#b18cff",
	"#d79a52",
	"#d36a8f",
	"#7aa66a",
];
export const TODO_LEAF_COLOUR = "#5f6874";

export function todoGroupColourForRoot(todo: TodoRecord): string {
	return normalizeTodoGroupColour(todo.group_colour)
		?? TODO_GROUP_COLOUR_PALETTE[hashTodoIdToPaletteIndex(todo.id, TODO_GROUP_COLOUR_PALETTE.length)];
}

/**
 * A sidebar list item's status: the status word plus `|key:value` metadata
 * that mpmux draws on the card (group colour bar, header label, right-hand
 * meta text).
 */
export function todoSidebarStatusWithAccent(status: string, colour: string, meta?: string, label?: string): string {
	return `${status}|accent:${colour}${meta ? `|meta:${meta}` : ""}${label ? `|label:${label}` : ""}`;
}

export function todoSidebarChildStatus(status: string, colour: string, meta?: string, label?: string): string {
	return `${todoSidebarStatusWithAccent(status, colour, meta, label)}|level:1`;
}

export function todoSidebarTagsLine(todo: TodoFrontMatter): string {
	return todo.tags.length ? todo.tags.map((tag) => `#${tag}`).join("  ") : "no tags";
}

export function todoSidebarChildCountLabel(childCount: number): string | undefined {
	if (childCount <= 0) return undefined;
	return `${childCount} child todo${childCount === 1 ? "" : "s"}`;
}

export function todoIndexRootId(index: TodoIndex, todoId: string): string | null {
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

export function buildTodoSidebarDetailLines(
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

export function todoClipboardId(todo: TodoFrontMatter): string {
	return formatTodoId(todo.id);
}

export function formatTodoMarkdownBodyLines(markdown: string): string[] {
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

export function buildTodoSidebarFullDetailLines(todo: TodoRecord, currentSessionId?: string): string[] {
	const lines = buildTodoSidebarDetailLines(todo, currentSessionId, 0).slice(0, -1);
	const bodyText = todo.body?.trim() ? todo.body.trim() : "No details yet.";
	lines.push("");
	lines.push(...formatTodoMarkdownBodyLines(bodyText));
	return lines;
}

export function buildTodoSidebarSurface(
	todos: TodoRecord[],
	selectedTodo: TodoRecord | null,
	search: string,
	currentSessionId?: string,
	options?: {
		expanded?: boolean;
		expandedRootIds?: ReadonlySet<string>;
		collapsedRootIds?: ReadonlySet<string>;
		allTodos?: TodoRecord[];
		filter?: TodoSidebarFilterState;
	},
) {
	const expanded = options?.expanded ?? false;
	const expandedRootIds = options?.expandedRootIds;
	const collapsedRootIds = options?.collapsedRootIds;
	const filter = options?.filter ?? { query: search };
	const summaryTodos = options?.allTodos ?? todos;
	const countsLabel = todoSidebarCountsLabel(summaryTodos);
	const index = buildTodoIndex(todos);
	const todoById = new Map(todos.map((todo) => [todo.id, todo] as const));
	const sidebarStatus = (todo: TodoRecord) => todoStatusWithOpenDescendants(todo, index, todoById);
	const openTodos = todos.filter((todo) => !isTodoClosed(sidebarStatus(todo)));
	const recentlyWorkedRootIds = index.groups.recently_worked
		.map((id) => index.graph.nodes[id]?.parent_ids[0] ?? id)
		.filter((id) => todoById.has(id))
		.filter((id, position, ids) => ids.indexOf(id) === position);
	const detailTodo = selectedTodo ?? openTodos[0] ?? todos[0] ?? null;
	const selectedRootId = detailTodo
		? index.graph.nodes[detailTodo.id]?.parent_ids[0] ?? detailTodo.id
		: null;

	// The todo id goes in the card header; the title carries only the title.
	const sidebarStatusForTodo = (todo: TodoRecord, colour: string, meta?: string, child = false) => {
		const status = sidebarStatus(todo);
		const statusColour = isTodoClosed(status) ? "#5f6874" : colour;
		const label = formatTodoId(todo.id);
		return child
			? todoSidebarChildStatus(status, statusColour, meta, label)
			: todoSidebarStatusWithAccent(status, statusColour, meta, label);
	};

	const buildListItems = (items: TodoRecord[]) =>
		items.map((todo) => ({
			id: todo.id,
			title: todo.title || "(untitled)",
			subtitle: todoSidebarTagsLine(todo),
			status: sidebarStatusForTodo(todo, normalizeTodoGroupColour(todo.group_colour) ?? TODO_LEAF_COLOUR),
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
				title: root.title || "(untitled)",
				subtitle: todoSidebarTagsLine(root),
				status: sidebarStatusForTodo(root, groupColour, todoSidebarChildCountLabel(childCount)),
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
						title: child.title || "(untitled)",
						subtitle: todoSidebarTagsLine(child),
						status: sidebarStatusForTodo(child, groupColour, undefined, true),
					});
				}
			}
			if (items.length >= maxVisible) break;
		}
		return items.slice(0, maxVisible);
	};

	const sections: Array<Record<string, unknown>> = [];

	if (filter.query.trim()) {
		sections.push({
			kind: "list",
			id: "todo-search-results",
			label: `${todos.length} ${todos.length === 1 ? "match" : "matches"} • ${todoSidebarCountsLabel(todos)}`,
			items: buildListItems(todos),
			selected_id: detailTodo?.id,
		});
	} else {
		sections.push({
			kind: "list",
			id: "todo-tree-list",
			label: `${expanded ? "Todo tree" : "Recent todos"} • ${countsLabel}`,
			items: buildTreeItems(),
			selected_id: detailTodo?.id,
		});
	}

	return {
		id: "pi-todos-sidebar",
		title: "Todos",
		filter: {
			value: filter.query,
			placeholder: "Filter todos… (#tag)",
			refresh_action_id: TODO_SIDEBAR_REFRESH_ITEM_ID,
		},
		sections,
	};
}

export function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

export function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

export function defaultMpmuxSocketPath(): string {
	const explicitTcp = process.env[MPMUX_HOST_CONTROL_TCP_ENV];
	if (explicitTcp && explicitTcp.trim().length > 0) return `tcp://${explicitTcp.trim()}`;

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

export function createMpmuxHostClientId(): string {
	return `pi-todos-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createMpmuxHostConnection(socketPath: string): net.Socket {
	if (!socketPath.startsWith("tcp://")) return net.createConnection(socketPath);

	const endpoint = new URL(socketPath);
	const port = Number(endpoint.port);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid ${MPMUX_HOST_CONTROL_TCP_ENV} endpoint: ${endpoint.host}`);
	}
	return net.createConnection({ host: endpoint.hostname, port });
}

export async function sendMpmuxHostRequest(
	socketPath: string,
	command: string,
	fields: Record<string, unknown>,
	timeoutMs = MPMUX_HOST_TIMEOUT_MS,
): Promise<unknown> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			return await sendMpmuxHostRequestOnce(socketPath, command, fields, timeoutMs);
		} catch (error) {
			if (attempt > 0 || !isMpmuxTransientHostRelayError(error)) throw error;
			await sleep(150);
		}
	}
	throw new Error(`mpmux host request failed unexpectedly: ${command}`);
}

export async function sendMpmuxHostRequestOnce(
	socketPath: string,
	command: string,
	fields: Record<string, unknown>,
	timeoutMs: number,
): Promise<unknown> {
	const request = JSON.stringify({ id: `pi-todos-${Date.now()}`, command, ...fields }) + "\n";

	return await new Promise<unknown>((resolve, reject) => {
		const client = createMpmuxHostConnection(socketPath);
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

export async function ensureMpmuxHostAttached(state: MpmuxHostSidebarState): Promise<void> {
	if (state.attached) return;
	await sendMpmuxHostRequest(state.socketPath, "attach", {
		client_id: state.clientId,
		target_client_id: state.clientId,
		name: state.clientName ?? "Pi todos sidebar",
		protocol_version: MPMUX_HOST_PROTOCOL_VERSION,
		role: "controller",
	});
	state.attached = true;
}

export async function withMpmuxHostControl<T>(
	state: MpmuxHostSidebarState,
	fn: () => Promise<T>,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		let acquired = false;
		try {
			await ensureMpmuxHostAttached(state);
			await sendMpmuxHostRequest(state.socketPath, "acquire-control", {
				client_id: state.clientId,
				target_client_id: state.clientId,
			});
			acquired = true;
			return await fn();
		} catch (error) {
			lastError = error;
			if (attempt > 0 || !isMpmuxHostUnavailableError(error)) throw error;
			state.attached = false;
			await sleep(150);
		} finally {
			if (acquired) {
				await sendMpmuxHostRequest(state.socketPath, "release-control", {
					client_id: state.clientId,
					target_client_id: state.clientId,
				}).catch(() => undefined);
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function showMpmuxTodoSidebar(
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

export async function clearMpmuxTodoSidebar(state: MpmuxHostSidebarState): Promise<void> {
	await withMpmuxHostControl(state, async () => {
		await sendMpmuxHostRequest(state.socketPath, "clear-custom-sidebar", {
			client_id: state.clientId,
		});
	});
}

export async function showMpmuxTodoDialog(
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

export async function clearMpmuxTodoDialog(state: MpmuxHostSidebarState): Promise<void> {
	await withMpmuxHostControl(state, async () => {
		await sendMpmuxHostRequest(state.socketPath, "clear-custom-dialog", {
			client_id: state.clientId,
		});
	});
}

export async function displayMpmuxTodoMessage(state: MpmuxHostSidebarState, message: string): Promise<void> {
	await withMpmuxHostControl(state, async () => {
		await sendMpmuxHostRequest(state.socketPath, "display-message", {
			client_id: state.clientId,
			message,
		});
	});
}

export async function copyTextToMpmuxHostClipboard(state: MpmuxHostSidebarState, text: string): Promise<void> {
	await withMpmuxHostControl(state, async () => {
		await sendMpmuxHostRequest(state.socketPath, "copy-to-clipboard", {
			client_id: state.clientId,
			text,
		});
	});
}

export async function subscribeMpmuxTodoHostEvents(state: MpmuxHostSidebarState): Promise<void> {
	await ensureMpmuxHostAttached(state);
	await sendMpmuxHostRequest(state.socketPath, "subscribe", {
		client_id: state.clientId,
		events: ["ui-state-changed", "custom-dialog-state-changed", "custom-sidebar-state-changed"],
	});
}

/** How long one `wait-for-events` may stay open before it is sent again. */
const MPMUX_EVENT_WAIT_TIMEOUT_MS = 10 * 60_000;

export async function waitMpmuxTodoHostEvents(state: MpmuxHostSidebarState): Promise<MpmuxHostPollEventsResponse> {
	await ensureMpmuxHostAttached(state);
	return (await sendMpmuxHostRequest(
		state.socketPath,
		"wait-for-events",
		{ client_id: state.clientId, max_events: 8 },
		MPMUX_EVENT_WAIT_TIMEOUT_MS,
	)) as MpmuxHostPollEventsResponse;
}

export async function pollMpmuxTodoHostEvents(state: MpmuxHostSidebarState): Promise<MpmuxHostPollEventsResponse> {
	await ensureMpmuxHostAttached(state);
	return (await sendMpmuxHostRequest(state.socketPath, "poll-events", {
		client_id: state.clientId,
		max_events: 8,
	})) as MpmuxHostPollEventsResponse;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function showMpmuxTodoUiState(state: MpmuxHostSidebarState): Promise<MpmuxUiState> {
	await ensureMpmuxHostAttached(state);
	return (await sendMpmuxHostRequest(state.socketPath, "show-ui-state", {
		client_id: state.clientId,
	})) as MpmuxUiState;
}

export function isMpmuxWaitTimeout(error: unknown): boolean {
	return error instanceof Error
		&& /timed out waiting for (mpmux host response|attached host-control response)/i.test(error.message);
}

/**
 * The sessiond relay answers requests one at a time and refuses commands
 * that stay open, such as `wait-for-events`; callers fall back to polling.
 */
export function isMpmuxEventWaitUnsupported(error: unknown): boolean {
	return error instanceof Error && /must be dispatched through the host-control bridge/i.test(error.message);
}

export function isMpmuxConnectionClosedBeforeResponse(error: unknown): boolean {
	return error instanceof Error && /connection closed before a host response was received/i.test(error.message);
}

export function isMpmuxAttachedSessionStreamClosed(error: unknown): boolean {
	return error instanceof Error && /attached session stream closed before host-control response/i.test(error.message);
}

export function isMpmuxTransientHostRelayError(error: unknown): boolean {
	return isMpmuxConnectionClosedBeforeResponse(error) || isMpmuxAttachedSessionStreamClosed(error);
}

export function isMpmuxHostUnavailableError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return isMpmuxTransientHostRelayError(error)
		|| isMpmuxWaitTimeout(error)
		|| /ECONNREFUSED|ENOENT|EPIPE|ECONNRESET/i.test(error.message);
}

export function isMpmuxOverlayAlreadyActiveError(error: unknown): boolean {
	return error instanceof Error && /another overlay is already active/i.test(error.message);
}

export function useExpandedTodoSidebarLayout(uiState: MpmuxUiState | null): boolean {
	if (!uiState) return false;
	if (uiState.message_sidebar.maximize_mode) return true;
	return (uiState.message_sidebar.visible_width_px ?? 0) >= 700;
}

export function buildTodoSidebarDialogSurface(todo: TodoRecord, currentSessionId?: string) {
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

export async function cleanupMpmuxHostSidebarState(state: MpmuxHostSidebarState): Promise<void> {
	if (!state.attached) return;
	await sendMpmuxHostRequest(state.socketPath, "detach", {
		client_id: state.clientId,
		target_client_id: state.clientId,
	}).catch(() => undefined);
	state.attached = false;
}

export async function ensureTodoExists(filePath: string, id: string): Promise<TodoRecord | null> {
	if (!existsSync(filePath)) return null;
	return readTodoFile(filePath, id);
}

export async function appendTodoBody(filePath: string, todo: TodoRecord, text: string): Promise<TodoRecord> {
	const spacer = todo.body.trim().length ? "\n\n" : "";
	todo.body = `${todo.body.replace(/\s+$/, "")}${spacer}${text.trim()}\n`;
	markTodoUpdated(todo);
	await writeTodoFile(filePath, todo);
	return todo;
}

export async function updateTodoStatus(
	todosDir: string,
	id: string,
	status: string,
	ctx: TodoAgentContext,
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

export async function claimTodoAssignment(
	todosDir: string,
	id: string,
	ctx: TodoAgentContext,
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

export async function releaseTodoAssignment(
	todosDir: string,
	id: string,
	ctx: TodoAgentContext,
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

export async function deleteTodo(
	todosDir: string,
	id: string,
	ctx: TodoAgentContext,
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

/** What the mpmux todo sidebar needs from the agent it runs beside. */
export type TodoSidebarAgent = {
	/** Working directory whose `.pi/todos` the sidebar shows. */
	cwd: string;
	/** Session context for todo locks and assignment. */
	ctx: TodoAgentContext;
	/** Show a short status message to the user. */
	notify(message: string, level: "info" | "warning" | "error"): void;
	/** Deliver a todo prompt such as "work on todo …" to the agent. */
	submitPrompt(prompt: string): void | Promise<void>;
	/** Optional extra clipboard copy next to the mpmux host clipboard. */
	copyText?(text: string): Promise<void>;
};

export type TodoSidebarAbortReason = "replace" | "clear" | "shutdown";

export type TodoSidebarRunOptions = {
	signal?: AbortSignal;
	/** Why `signal` was aborted, if it was; "replace" keeps the sidebar up. */
	abortReason?: () => TodoSidebarAbortReason | undefined;
	/**
	 * Block in `wait-for-events` instead of polling. Only for a runner with a
	 * host-control connection of its own: inside Pi a blocked request would
	 * hold up the shared bridge.
	 */
	waitForEvents?: boolean;
	/** Checked when the host UI changes; true stops the sidebar. */
	agentGone?: () => Promise<boolean>;
};

function deliverTodoPrompt(agent: TodoSidebarAgent, prompt: string): void {
	Promise.resolve()
		.then(() => agent.submitPrompt(prompt))
		.catch((error) => agent.notify(`Todo action failed: ${error instanceof Error ? error.message : String(error)}`, "error"));
}

export function workPromptForTodo(todo: TodoFrontMatter): string {
	return `work on todo ${formatTodoId(todo.id)} "${todo.title || "(untitled)"}"`;
}


export function selectedTodoFromId(todos: TodoRecord[], selectedTodoId: string | null): TodoRecord | null {
	if (selectedTodoId) {
		const exact = todos.find((todo) => todo.id === normalizeTodoId(selectedTodoId));
		if (exact) return exact;
	}
	return todos.find((todo) => !isTodoClosed(getTodoStatus(todo))) ?? todos[0] ?? null;
}


/**
 * Run the mpmux todo sidebar until `options.signal` aborts or the host goes
 * away: show the sidebar, follow host events, and apply todo actions.
 */
export async function runTodoSidebarHostUi(
	args: string,
	agent: TodoSidebarAgent,
	state: MpmuxHostSidebarState,
	options: TodoSidebarRunOptions = {},
): Promise<void> {
	const { signal } = options;
	const trimmedArgs = (args ?? "").trim();

	const todosDir = getTodosDir(agent.cwd);
	const currentSessionId = agent.ctx.sessionManager.getSessionId();
	let uiState: MpmuxUiState | null = null;
	const initialTodoId = trimmedArgs && !("error" in validateTodoId(trimmedArgs)) ? normalizeTodoId(trimmedArgs) : null;
	let sidebarFilter: TodoSidebarFilterState = {
		query: trimmedArgs && !initialTodoId ? trimmedArgs : "",
	};
	let selectedTodoId: string | null = initialTodoId;
	const expandedRootIds = new Set<string>();
	const collapsedRootIds = new Set<string>();
	// Set from the host state below. Starting at 0 dropped the first action
	// after an mpmux start, which itself carries nonce 0.
	let lastSidebarInteractionNonce = -1;
	let lastDialogActionNonce = -1;
	let keepRunning = !signal?.aborted;
	let sidebarDirty = false;
	// Cleared when the host cannot hold a request open (the sessiond relay).
	let waitForEvents = options.waitForEvents ?? false;
	let todosWatcher: FSWatcher | null = null;

	// Event wait for `options.waitForEvents`. One request stays outstanding
	// across wakeups: a second wait for the same client could take events
	// that the first one then never reports.
	let pendingWait: Promise<MpmuxHostPollEventsResponse | Error> | null = null;
	let wakeForDirty: (() => void) | null = null;
	const aborted = new Promise<"abort">((resolve) => {
		if (signal?.aborted) resolve("abort");
		signal?.addEventListener("abort", () => resolve("abort"), { once: true });
	});
	const waitForWake = async (): Promise<MpmuxHostPollEventsResponse | Error | "dirty" | "abort"> => {
		pendingWait ??= waitMpmuxTodoHostEvents(state).catch((error: unknown) =>
			error instanceof Error ? error : new Error(String(error)),
		);
		const dirty = new Promise<"dirty">((resolve) => {
			wakeForDirty = () => resolve("dirty");
		});
		const outcome = await Promise.race([pendingWait, dirty, aborted]);
		wakeForDirty = null;
		if (outcome !== "dirty" && outcome !== "abort") pendingWait = null;
		return outcome;
	};

	const refreshSidebar = async () => {
		const todos = await listTodoRecords(todosDir);
		const visibleTodos = filterTodosForSidebar(todos, sidebarFilter);
		const selectedTodo = selectedTodoFromId(visibleTodos, selectedTodoId);
		selectedTodoId = selectedTodo?.id ?? null;
		await showMpmuxTodoSidebar(
			state,
			buildTodoSidebarSurface(visibleTodos, selectedTodo, sidebarFilter.query, currentSessionId, {
				expanded: useExpandedTodoSidebarLayout(uiState),
				expandedRootIds,
				collapsedRootIds,
				allTodos: todos,
				filter: sidebarFilter,
			}),
		);
	};

	const toggleTodoTreeRoot = async (todoId: string, options: { collapseOnly?: boolean; expandOnly?: boolean } = {}): Promise<boolean> => {
		const todos = await listTodoRecords(todosDir);
		const visibleTodos = filterTodosForSidebar(todos, sidebarFilter);
		const index = buildTodoIndex(visibleTodos);
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
			agent.notify(`Todo ${displayTodoId(todoId)} not found`, "error");
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
			agent.notify(`Todo ${displayTodoId(todoId)} not found`, "error");
			await refreshSidebar();
			return;
		}
		selectedTodoId = todo.id;
		const label = todoClipboardId(todo);
		try {
			await agent.copyText?.(label);
			await copyTextToMpmuxHostClipboard(state, label);
			agent.notify(`Copied ${label}`, "info");
		} catch (error) {
			agent.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	const forceRefreshSidebar = async () => {
		sidebarDirty = false;
		await refreshSidebar();
		agent.notify("Todo sidebar refreshed", "info");
	};

	const updateSidebarFilter = async (query: string) => {
		if (sidebarFilter.query === query) return;
		sidebarFilter = { query };
		selectedTodoId = null;
		expandedRootIds.clear();
		collapsedRootIds.clear();
		await refreshSidebar();
	};

	const applyDialogAction = async (action: MpmuxCustomDialogActionEvent["result"]) => {
		const actionId = action.action_id;
		if (!selectedTodoId) return;
		const currentTodos = await listTodoRecords(todosDir);
		const todo = currentTodos.find((item) => item.id === selectedTodoId);
		if (!todo) {
			agent.notify(`Todo ${displayTodoId(selectedTodoId)} not found`, "error");
			await refreshSidebar();
			return;
		}

		switch (actionId) {
			case "work": {
				deliverTodoPrompt(agent, workPromptForTodo(todo));
				return;
			}
			case "refine": {
				deliverTodoPrompt(agent, buildRefinePrompt(todo.id, todo.title || "(untitled)"));
				return;
			}
			case "claim-toggle": {
				const result = !todo.assigned_to_session
					? await claimTodoAssignment(todosDir, todo.id, agent.ctx, false)
					: todo.assigned_to_session === currentSessionId
						? await releaseTodoAssignment(todosDir, todo.id, agent.ctx, false)
						: await claimTodoAssignment(todosDir, todo.id, agent.ctx, true);
				if ("error" in result) {
					agent.notify(result.error, "error");
				} else {
					agent.notify(
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
				if (nextStatus === "closed") {
					const index = buildTodoIndex(currentTodos);
					const todoById = new Map(currentTodos.map((item) => [item.id, item] as const));
					if (todoHasOpenDescendant(todo, index, todoById)) {
						agent.notify(`Cannot close ${formatTodoId(todo.id)} while child todos are open`, "error");
						await refreshSidebar();
						return;
					}
				}
				const result = await updateTodoStatus(todosDir, todo.id, nextStatus, agent.ctx);
				if ("error" in result) {
					agent.notify(result.error, "error");
				} else {
					const message = nextStatus === "closed"
						? `Closed ${formatTodoId(todo.id)}`
						: `Reopened ${formatTodoId(todo.id)}`;
					await displayMpmuxTodoMessage(state, message).catch(() => undefined);
					agent.notify(message, "info");
				}
				await refreshSidebar();
				return;
			}
		}
	};

	try {
		await ensureTodosDir(todosDir);
		todosWatcher = watch(todosDir, () => {
			// fs.watch can report platform-specific event names and can omit filenames.
			// Treat any todos-dir change as a sidebar invalidation so external todo
			// updates are visible without requiring a manual command restart.
			sidebarDirty = true;
			wakeForDirty?.();
		});
		await ensureMpmuxHostAttached(state);
		await subscribeMpmuxTodoHostEvents(state);
		uiState = await showMpmuxTodoUiState(state);
		// Interactions from before this sidebar run are not ours to replay.
		lastSidebarInteractionNonce = uiState?.custom_sidebar?.last_interaction?.nonce ?? -1;
		lastDialogActionNonce = uiState?.custom_dialog?.last_action?.nonce ?? -1;
		await refreshSidebar();

		while (keepRunning && !signal?.aborted) {
			if (sidebarDirty) {
				sidebarDirty = false;
				await refreshSidebar();
			}

			let response: MpmuxHostPollEventsResponse;
			if (waitForEvents) {
				const outcome = await waitForWake();
				if (outcome === "dirty" || outcome === "abort") continue;
				if (outcome instanceof Error) {
					if (isMpmuxWaitTimeout(outcome)) continue;
					if (isMpmuxEventWaitUnsupported(outcome)) {
						waitForEvents = false;
						continue;
					}
					throw outcome;
				}
				response = outcome;
			} else {
				try {
					response = await pollMpmuxTodoHostEvents(state);
				} catch (error) {
					if (isMpmuxWaitTimeout(error)) {
						await sleep(250);
						continue;
					}
					throw error;
				}
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

			if (options.agentGone && response.events.some((event) => event.ui_state) && (await options.agentGone())) {
				agent.notify("Agent pane closed; todo sidebar stopped", "info");
				keepRunning = false;
				break;
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
					if (event.custom_sidebar.selected_item_id && !isTodoSidebarActionItemId(event.custom_sidebar.selected_item_id)) {
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
						if (interaction.kind === "filter-changed") {
							await updateSidebarFilter(interaction.value ?? "");
							continue;
						}
						if (interaction.kind === "item-invoked" && interaction.item_id) {
							if (interaction.item_id === TODO_SIDEBAR_REFRESH_ITEM_ID) {
								await forceRefreshSidebar();
								continue;
							}
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
							if (source.startsWith("pie-")) {
								switch (source) {
									case "pie-copy-id":
										await copySelectedTodoReference(interaction.item_id);
										break;
									case "pie-work": {
										const todo = (await listTodoRecords(todosDir)).find((candidate) => candidate.id === normalizeTodoId(interaction.item_id));
										if (todo) deliverTodoPrompt(agent, workPromptForTodo(todo));
										break;
									}
									case "pie-refine": {
										const todo = (await listTodoRecords(todosDir)).find((candidate) => candidate.id === normalizeTodoId(interaction.item_id));
										if (todo) deliverTodoPrompt(agent, buildRefinePrompt(todo.id, todo.title || "(untitled)"));
										break;
									}
									case "pie-claim":
										selectedTodoId = normalizeTodoId(interaction.item_id);
										await applyDialogAction({
											dialog_id: "todo-sidebar-pie",
											action_id: "claim-toggle",
											submitted: true,
											values: [],
										});
										break;
									case "pie-close":
										selectedTodoId = normalizeTodoId(interaction.item_id);
										await applyDialogAction({
											dialog_id: "todo-sidebar-pie",
											action_id: "status-toggle",
											submitted: true,
											values: [],
										});
										break;
									case "pie-view":
									case "pie-details":
									case "pie-more":
										await openSelectedTodoDialog(interaction.item_id);
										break;
									default:
										agent.notify(`Unhandled todo pie action: ${source}`, "warning");
								}
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
						await applyDialogAction(action.result);
					}
				}
			}
		}
	} catch (error) {
		const abortReason = options.abortReason?.();
		const expectedStop = signal?.aborted || abortReason;
		const attachedHostDropped = state.attached && isMpmuxHostUnavailableError(error);
		if (expectedStop || attachedHostDropped) {
			console.warn(`mpmux todo sidebar stopped: ${error instanceof Error ? error.message : String(error)}`);
		} else {
			agent.notify(
				`mpmux todo sidebar unavailable: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	} finally {
		todosWatcher?.close();
		const abortReason = options.abortReason?.();
		if (abortReason !== "replace") {
			await clearMpmuxTodoDialog(state).catch(() => undefined);
			await clearMpmuxTodoSidebar(state).catch(() => undefined);
			await cleanupMpmuxHostSidebarState(state).catch(() => undefined);
		}
	}
}
