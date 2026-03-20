/**
 * Result Actions Extension
 *
 * When the user asks for a list of files, this extension remembers the result.
 * Press Ctrl+Shift+L to act on the last result:
 *   - Copy to clipboard
 *   - Open files with quicklook
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Text, type TUI } from "@mariozechner/pi-tui";

// Platform-specific quicklook configuration
type QuickLookConfig = {
	command: string | null;
	args: (filePath: string) => string[];
};

const getQuickLookConfig = (): QuickLookConfig => {
	// macOS
	if (process.platform === "darwin") {
		return {
			command: "qlmanage",
			args: (filePath) => ["-p", filePath],
		};
	}

	// Linux - check for sushi
	const hasSushi = (() => {
		try {
			const result = spawnSync("which", ["sushi"], { encoding: "utf8" });
			return result.status === 0;
		} catch {
			return false;
		}
	})();

	if (hasSushi) {
		return {
			command: "sushi",
			args: (filePath) => [filePath],
		};
	}

	return { command: null, args: () => [] };
};

const QUICKLOOK = getQuickLookConfig();

// Platform-specific open configuration (from files.ts extension)
type OpenConfig = {
	command: string;
};

const getOpenConfig = (): OpenConfig => {
	// macOS
	if (process.platform === "darwin") {
		return { command: "open" };
	}

	// Linux and others
	return { command: "xdg-open" };
};

const OPEN = getOpenConfig();

// Extract file paths from text (supports absolute paths, @paths, quoted paths, filenames)
const extractFilePaths = (text: string, cwd: string): string[] => {
	const paths: string[] = [];
	const os = require("node:os");

	// Match @file paths (pi file references)
	const atFileRegex = /@([^\s"'<>]+)/g;
	for (const match of text.matchAll(atFileRegex)) {
		const p = match[1].trim();
		if (p && !p.startsWith("http") && !p.includes("://")) {
			// Resolve @ paths - they could be @~/path or @path
			if (p.startsWith("~/")) {
				const resolved = path.join(os.homedir(), p.slice(2));
				if (existsSync(resolved)) {
					paths.push(resolved);
				}
			} else if (path.isAbsolute(p)) {
				if (existsSync(p)) {
					paths.push(p);
				}
			} else {
				// Try resolving relative to cwd
				const resolved = path.resolve(cwd, p);
				if (existsSync(resolved)) {
					paths.push(resolved);
				}
			}
		}
	}

	// Match absolute paths
	const absoluteRegex = /(?:^|\s)(\/[^\s"'<>]+)/g;
	for (const match of text.matchAll(absoluteRegex)) {
		const p = match[1].trim();
		if (p && existsSync(p)) {
			paths.push(p);
		}
	}

	// Match home directory paths (~/...)
	const homeRegex = /(?:^|\s)(~\/[^\s"'<>]+)/g;
	for (const match of text.matchAll(homeRegex)) {
		const p = path.join(os.homedir(), match[1].slice(1));
		if (existsSync(p)) {
			paths.push(p);
		}
	}

	// Match filenames with extensions that appear to be files
	// This helps when the assistant shows a table with just filenames
	const fileNameRegex = /[\│├┤┌┐└┘┬┴┼─]\s*([a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9]+)\s*[\│├┤┌┐└┘┬┴┼─\n]/g;
	for (const match of text.matchAll(fileNameRegex)) {
		const filename = match[1].trim();
		if (filename && !filename.includes(" ")) {
			// Try to find this file - look in cwd first, then home, then common dirs
			const locations = [
				path.resolve(cwd, filename),
				path.join(os.homedir(), filename),
				path.join(os.homedir(), "Bilder", filename),
				path.join(os.homedir(), "Pictures", filename),
				path.join(os.homedir(), "Downloads", filename),
				path.join(os.homedir(), "Documents", filename),
			];
			for (const location of locations) {
				if (existsSync(location)) {
					paths.push(location);
					break;
				}
			}
		}
	}

	// Deduplicate while preserving order
	return [...new Set(paths)];
};

// Store for the last file list result
let lastFileListResult: string | null = null;
let lastExtractedPaths: string[] = [];

// Extract file list from assistant messages
type ContentBlock = {
	type?: string;
	text?: string;
};

const extractFromContent = (content: unknown): string | null => {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return null;
	}

	const texts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			texts.push(block.text);
		}
	}

	return texts.join("\n");
};

const findLatestFileList = (entries: SessionEntry[]): string | null => {
	// Look for assistant messages that contain file listings
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		const msg = entry.message;
		if (msg.role !== "assistant") continue;

		const text = extractFromContent(msg.content);
		if (!text) continue;

		// Check if this looks like a file list (contains paths or file-related keywords)
		const hasFilePaths = text.includes("/") && (text.includes(".") || text.includes("@"));
		const hasFileKeywords = /\b(file|files|path|paths|bilder|bild|screenshot|picture|image)\b/i.test(text);
		const hasListIndicators = text.includes("\n") && (text.match(/\n/g)?.length ?? 0) >= 1;

		if (hasFilePaths || (hasFileKeywords && hasListIndicators)) {
			return text;
		}
	}

	return null;
};

// Copy text to clipboard using xsel
const copyToClipboard = async (pi: ExtensionAPI, ctx: ExtensionContext, text: string): Promise<void> => {
	try {
		// Write to a temp file and pipe to xsel
		const { mkdtempSync, writeFileSync, unlinkSync } = require("node:fs");
		const os = require("node:os");
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "pi-result-"));
		const tmpFile = path.join(tmpDir, "clipboard.txt");

		writeFileSync(tmpFile, text, "utf8");

		const result = await pi.exec("bash", ["-c", `cat "${tmpFile}" | xsel --clipboard --input`]);

		try {
			unlinkSync(tmpFile);
		} catch {}

		if (result.code !== 0) {
			ctx.ui.notify("Failed to copy to clipboard. Is xsel installed?", "error");
			return;
		}

		ctx.ui.notify("Copied to clipboard!", "success");
	} catch (err) {
		ctx.ui.notify(`Clipboard error: ${err}`, "error");
	}
};

// Open file with quicklook
const quickLookFile = async (pi: ExtensionAPI, ctx: ExtensionContext, filePath: string): Promise<void> => {
	if (!existsSync(filePath)) {
		ctx.ui.notify(`File not found: ${filePath}`, "error");
		return;
	}

	const stats = statSync(filePath);
	if (stats.isDirectory()) {
		ctx.ui.notify("Quick Look only works on files", "warning");
		return;
	}

	if (!QUICKLOOK.command) {
		// Fallback: try xdg-open
		const result = await pi.exec("xdg-open", [filePath]);
		if (result.code !== 0) {
			ctx.ui.notify("No quick look tool available. Install 'sushi' or use 'Open' instead.", "error");
		}
		return;
	}

	const result = await pi.exec(QUICKLOOK.command, QUICKLOOK.args(filePath));
	if (result.code !== 0) {
		ctx.ui.notify(`Quick Look failed: ${result.stderr || "unknown error"}`, "error");
	}
};

// Open all files with quicklook (sequentially)
const quickLookAllFiles = async (pi: ExtensionAPI, ctx: ExtensionContext, paths: string[]): Promise<void> => {
	if (paths.length === 0) {
		ctx.ui.notify("No files to open", "warning");
		return;
	}

	// Filter to existing files only
	const existingFiles = paths.filter((p) => existsSync(p) && !statSync(p).isDirectory());

	if (existingFiles.length === 0) {
		ctx.ui.notify("No valid files found to open", "warning");
		return;
	}

	if (existingFiles.length === 1) {
		await quickLookFile(pi, ctx, existingFiles[0]);
		return;
	}

	// Open all files
	ctx.ui.notify(`Opening ${existingFiles.length} files...`, "info");
	for (const filePath of existingFiles) {
		await quickLookFile(pi, ctx, filePath);
		// Small delay between opens to not overwhelm the system
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
};

// Reveal files in Nautilus using D-Bus
const revealFiles = async (pi: ExtensionAPI, ctx: ExtensionContext, paths: string[]): Promise<void> => {
	if (paths.length === 0) {
		ctx.ui.notify("No files to reveal", "warning");
		return;
	}

	// Filter to existing files/directories
	const existingPaths = paths.filter((p) => existsSync(p));

	if (existingPaths.length === 0) {
		ctx.ui.notify("No valid files found to reveal", "warning");
		return;
	}

	// Build file:// URIs
	const uris = existingPaths.map((p) => `file://${p}`);
	const uriArray = `['${uris.join("','")}']`;

	try {
		const result = await pi.exec("gdbus", [
			"call",
			"--session",
			"--dest", "org.gnome.Nautilus",
			"--object-path", "/org/freedesktop/FileManager1",
			"--method", "org.freedesktop.FileManager1.ShowItems",
			uriArray,
			"",
		]);

		if (result.code !== 0) {
			ctx.ui.notify(`Failed to reveal files: ${result.stderr || "unknown error"}`, "error");
			return;
		}

		ctx.ui.notify(`Revealed ${existingPaths.length} file${existingPaths.length > 1 ? "s" : ""} in Nautilus`, "success");
	} catch (err) {
		ctx.ui.notify(`Failed to reveal files: ${err}`, "error");
	}
};

// Open a single file with the default application
const openFile = async (pi: ExtensionAPI, ctx: ExtensionContext, filePath: string): Promise<void> => {
	if (!existsSync(filePath)) {
		ctx.ui.notify(`File not found: ${filePath}`, "error");
		return;
	}

	const result = await pi.exec(OPEN.command, [filePath]);
	if (result.code !== 0) {
		const errorMessage = result.stderr?.trim() || `Failed to open ${filePath}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

// Open all files with the default application
const openAllFiles = async (pi: ExtensionAPI, ctx: ExtensionContext, paths: string[]): Promise<void> => {
	if (paths.length === 0) {
		ctx.ui.notify("No files to open", "warning");
		return;
	}

	// Filter to existing files and directories
	const existingPaths = paths.filter((p) => existsSync(p));

	if (existingPaths.length === 0) {
		ctx.ui.notify("No valid files found to open", "warning");
		return;
	}

	if (existingPaths.length === 1) {
		await openFile(pi, ctx, existingPaths[0]);
		return;
	}

	// Open all files
	ctx.ui.notify(`Opening ${existingPaths.length} file(s)...`, "info");
	for (const filePath of existingPaths) {
		await openFile(pi, ctx, filePath);
		// Small delay between opens to not overwhelm the system
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
};

// Show action selector UI
const showActionSelector = async (
	ctx: ExtensionContext,
	resultText: string,
	paths: string[],
): Promise<"copy" | "reveal" | "open" | "quicklook" | null> => {
	const fileCount = paths.length;

	const actions: SelectItem[] = [
		{ value: "copy", label: "📋 Copy to clipboard" },
		...(fileCount > 0
			? [
					{ value: "reveal", label: `🔍 Reveal ${fileCount} file${fileCount > 1 ? "s" : ""} in Nautilus` },
					{ value: "open", label: `📂 Open ${fileCount} file${fileCount > 1 ? "s" : ""}` },
					{ value: "quicklook", label: `👁 Quick Look ${fileCount} file${fileCount > 1 ? "s" : ""}` },
				]
			: []),
	];

	if (actions.length === 0) {
		ctx.ui.notify("No actions available for this result", "warning");
		return null;
	}

	return ctx.ui.custom<"copy" | "reveal" | "open" | "quicklook" | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("What would you like to do with this result?"))));

		const selectList = new SelectList(actions, actions.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		selectList.onSelect = (item) => done(item.value as "copy" | "quicklook" | "open");
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
};

// Main handler for Ctrl+Shift+L
const handleResultAction = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
	if (!ctx.hasUI) {
		ctx.ui.notify("Result actions require interactive mode", "error");
		return;
	}

	// First, try to find a fresh result from the session
	const entries = ctx.sessionManager.getBranch();
	const freshResult = findLatestFileList(entries);

	if (freshResult) {
		lastFileListResult = freshResult;
		lastExtractedPaths = extractFilePaths(freshResult, ctx.cwd);
	}

	if (!lastFileListResult) {
		ctx.ui.notify("No file list result found. Ask for a list of files first.", "warning");
		return;
	}

	// Show the action selector
	const action = await showActionSelector(ctx, lastFileListResult, lastExtractedPaths);

	if (!action) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	switch (action) {
		case "copy":
			await copyToClipboard(pi, ctx, lastFileListResult);
			break;
		case "reveal":
			await revealFiles(pi, ctx, lastExtractedPaths);
			break;
		case "open":
			await openAllFiles(pi, ctx, lastExtractedPaths);
			break;
		case "quicklook":
			await quickLookAllFiles(pi, ctx, lastExtractedPaths);
			break;
	}
};

export default function (pi: ExtensionAPI): void {
	// Register the Ctrl+Shift+L shortcut
	pi.registerShortcut("ctrl+shift+l", {
		description: "Act on the last file list result (copy to clipboard or quick look)",
		handler: async (ctx) => {
			await handleResultAction(pi, ctx);
		},
	});

	// Also register as a command for discoverability
	pi.registerCommand("result-action", {
		description: "Show actions for the last file list result",
		handler: async (_args, ctx) => {
			await handleResultAction(pi, ctx);
		},
	});
}
