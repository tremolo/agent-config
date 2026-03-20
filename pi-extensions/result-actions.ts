/**
 * Result Actions Extension
 *
 * When the user asks for a list of files, this extension remembers the result.
 * Press Ctrl+Shift+L to act on the last result:
 *   - Copy to clipboard
 *   - Open files with quicklook
 *   - Reveal files in Nautilus
 *   - Open files with default application
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { openInNautilus } from "./nautilus-open.js";

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

// Platform-specific open configuration
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

	// Helper to add a path if it exists and is a file (not a directory)
	const addIfExists = (p: string): boolean => {
		try {
			if (existsSync(p) && !statSync(p).isDirectory()) {
				paths.push(p);
				return true;
			}
		} catch {
			// Ignore errors for invalid paths
		}
		return false;
	};

	// Helper to resolve ~ paths
	const expandHome = (p: string): string => {
		if (p.startsWith("~/")) {
			return path.join(os.homedir(), p.slice(2));
		}
		return p;
	};

	// Match @file paths (pi file references) - e.g., @~/path/file or @/abs/path
	const atFileRegex = /@([^\s"'<>|]+)/g;
	for (const match of text.matchAll(atFileRegex)) {
		const p = match[1].trim();
		if (p && !p.startsWith("http") && !p.includes("://")) {
			const expanded = expandHome(p);
			if (path.isAbsolute(expanded)) {
				addIfExists(expanded);
			} else {
				addIfExists(path.resolve(cwd, expanded));
			}
		}
	}

	// Match absolute paths (starting with /)
	const absoluteRegex = /(?:^|[\s"'`([\]{}])(\/([\w\-./]+))/gm;
	for (const match of text.matchAll(absoluteRegex)) {
		const p = match[1].trim();
		if (p && p.length > 1) {
			addIfExists(p);
		}
	}

	// Match home directory paths (~/...)
	const homeRegex = /(?:^|[\s"'`([\]{}])(~\/[\w\-./]+)/gm;
	for (const match of text.matchAll(homeRegex)) {
		const p = expandHome(match[1].trim());
		addIfExists(p);
	}

	// Match relative paths with ./ prefix
	const relativeRegex = /(?:^|[\s"'`([\]{}])(\.\/[\w\-./]+)/gm;
	for (const match of text.matchAll(relativeRegex)) {
		const p = path.resolve(cwd, match[1].trim());
		addIfExists(p);
	}

	// Match common file patterns (filenames with extensions)
	// Look for patterns like "filename.ext" in various contexts (including markdown **bold**)
	const fileNameRegex = /(?:^|[\s│├┤┬┴┼─|`"'([\]{}*])([a-zA-Z0-9_\-]+\.[a-zA-Z0-9]{1,10})(?=$|[\s│├┤┬┴┼─|`"')\]{},:;\n*])/gm;
	for (const match of text.matchAll(fileNameRegex)) {
		const filename = match[1].trim();
		// Skip common false positives
		if (!filename || filename.includes(" ") || /^\d+\.\d+$/.test(filename)) {
			continue;
		}

		// Try to find this file in various locations
		const searchLocations = [
			cwd,
			os.homedir(),
			path.join(os.homedir(), "Bilder"),
			path.join(os.homedir(), "Pictures"),
			path.join(os.homedir(), "Downloads"),
			path.join(os.homedir(), "Documents"),
			path.join(os.homedir(), "Desktop"),
		];

		for (const location of searchLocations) {
			const fullPath = path.join(location, filename);
			if (addIfExists(fullPath)) {
				break;
			}
		}
	}

	// Match quoted paths
	const quotedRegex = /["'`]([^"'`\n]+\.[a-zA-Z0-9]{1,10})["'`]/g;
	for (const match of text.matchAll(quotedRegex)) {
		const p = match[1].trim();
		if (p.includes("/")) {
			const expanded = expandHome(p);
			if (path.isAbsolute(expanded)) {
				addIfExists(expanded);
			} else {
				addIfExists(path.resolve(cwd, expanded));
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

const findLatestFileList = (entries: SessionEntry[], cwd: string): { text: string; paths: string[] } | null => {
	// Look for assistant messages that contain file listings (most recent first)
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		const msg = entry.message;
		if (msg.role !== "assistant") continue;

		const text = extractFromContent(msg.content);
		if (!text) continue;

		// Try to extract paths from this message
		const paths = extractFilePaths(text, cwd);

		// If we found paths, this is likely a file list message
		if (paths.length > 0) {
			return { text, paths };
		}

		// Also check if this looks like a file list even without extractable paths
		// (user might want to copy the text)
		const hasFilePaths = text.includes("/") && (text.includes(".") || text.includes("@"));
		const hasFileKeywords = /\b(file|files|path|paths|bilder|bild|screenshot|picture|image|foto|photo)\b/i.test(text);
		const hasListIndicators = text.includes("\n") && (text.match(/\n/g)?.length ?? 0) >= 1;

		if (hasFilePaths || (hasFileKeywords && hasListIndicators)) {
			return { text, paths: [] };
		}
	}

	return null;
};

// Copy text to clipboard using xsel or xclip
const copyToClipboard = async (pi: ExtensionAPI, ctx: ExtensionContext, text: string): Promise<void> => {
	try {
		// Write to a temp file and pipe to clipboard tool
		const { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } = require("node:fs");
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "pi-result-"));
		const tmpFile = path.join(tmpDir, "clipboard.txt");

		writeFileSync(tmpFile, text, "utf8");

		// Try xsel first, then xclip
		let result = await pi.exec("bash", ["-c", `cat "${tmpFile}" | xsel --clipboard --input 2>/dev/null`]);

		if (result.code !== 0) {
			result = await pi.exec("bash", ["-c", `cat "${tmpFile}" | xclip -selection clipboard 2>/dev/null`]);
		}

		try {
			unlinkSync(tmpFile);
			rmdirSync(tmpDir);
		} catch {
			// Ignore cleanup errors
		}

		if (result.code !== 0) {
			ctx.ui.notify("Failed to copy to clipboard. Install xsel or xclip.", "error");
			return;
		}

		ctx.ui.notify("Copied to clipboard!", "info");
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
	const existingFiles = paths.filter((p) => {
		try {
			return existsSync(p) && !statSync(p).isDirectory();
		} catch {
			return false;
		}
	});

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

// Reveal files in Nautilus using the nautilus-open extension (supports proper multi-select)
const revealFiles = async (pi: ExtensionAPI, ctx: ExtensionContext, paths: string[]): Promise<void> => {
	if (paths.length === 0) {
		ctx.ui.notify("No files to reveal", "warning");
		return;
	}

	// Filter to existing files/directories
	const existingPaths = paths.filter((p) => {
		try {
			return existsSync(p);
		} catch {
			return false;
		}
	});

	if (existingPaths.length === 0) {
		ctx.ui.notify("No valid files found to reveal", "warning");
		return;
	}

	// Use the nautilus-open extension for proper multi-file selection
	const result = await openInNautilus(existingPaths, pi);

	if (result.success) {
		const dirMsg = result.directoriesOpened > 1
			? ` in ${result.directoriesOpened} folders`
			: "";
		const extMsg = result.hasExtension ? "" : " (single-select mode)";
		ctx.ui.notify(
			`Revealed ${result.filesOpened} file${result.filesOpened > 1 ? "s" : ""}${dirMsg}${extMsg}`,
			"info"
		);
	} else {
		// Fallback: open the directory containing the first file
		try {
			const firstFile = existingPaths[0];
			const dir = statSync(firstFile).isDirectory() ? firstFile : path.dirname(firstFile);
			await pi.exec("xdg-open", [dir]);
			ctx.ui.notify(`Opened folder (Nautilus integration failed)`, "warning");
		} catch (err) {
			ctx.ui.notify(`Failed to reveal files: ${result.errors.join("; ")}`, "error");
		}
	}
};

// Open a single file with the default application
const openFile = async (pi: ExtensionAPI, ctx: ExtensionContext, filePath: string): Promise<void> => {
	if (!existsSync(filePath)) {
		ctx.ui.notify(`File not found: ${filePath}`, "error");
		return;
	}

	if (statSync(filePath).isDirectory()) {
		ctx.ui.notify(`Cannot open directory: ${filePath}`, "warning");
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

	// Filter to existing files only (not directories)
	const existingFiles = paths.filter((p) => {
		try {
			return existsSync(p) && !statSync(p).isDirectory();
		} catch {
			return false;
		}
	});

	if (existingFiles.length === 0) {
		ctx.ui.notify("No valid files found to open", "warning");
		return;
	}

	if (existingFiles.length === 1) {
		await openFile(pi, ctx, existingFiles[0]);
		ctx.ui.notify(`Opened ${path.basename(existingFiles[0])}`, "info");
		return;
	}

	// Open all files
	ctx.ui.notify(`Opening ${existingFiles.length} file(s)...`, "info");
	for (const filePath of existingFiles) {
		await openFile(pi, ctx, filePath);
		// Small delay between opens to not overwhelm the system
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	ctx.ui.notify(`Opened ${existingFiles.length} files`, "info");
};

// Show action selector UI
const showActionSelector = async (
	ctx: ExtensionContext,
	resultText: string,
	paths: string[]
): Promise<"copy" | "reveal" | "open" | "quicklook" | null> => {
	const fileCount = paths.length;

	// Build actions array - always include copy, conditionally add file actions
	const actions: SelectItem[] = [];

	// Always add copy option
	actions.push({ value: "copy", label: "📋 Copy result to clipboard" });

	// Add file actions if we have files
	if (fileCount > 0) {
		actions.push({
			value: "reveal",
			label: `🔍 Reveal ${fileCount} file${fileCount > 1 ? "s" : ""} in Nautilus`,
		});
		actions.push({
			value: "open",
			label: `📂 Open ${fileCount} file${fileCount > 1 ? "s" : ""} with default app`,
		});
		actions.push({
			value: "quicklook",
			label: `👁 Quick Look ${fileCount} file${fileCount > 1 ? "s" : ""}`,
		});
	}

	return ctx.ui.custom<"copy" | "reveal" | "open" | "quicklook" | null>((tui, theme, _kb, done) => {
		const container = new Container();

		// Top border
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		// Title with context
		const title = fileCount > 0
			? `Actions for result (${fileCount} file${fileCount > 1 ? "s" : ""} found)`
			: "Actions for result (no files detected)";
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		// SelectList with theme
		const selectList = new SelectList(actions, Math.min(actions.length, 10), {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		});

		selectList.onSelect = (item) => done(item.value as "copy" | "reveal" | "open" | "quicklook");
		selectList.onCancel = () => done(null);

		container.addChild(selectList);

		// Help text
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));

		// Bottom border
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

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

	// Always try to find a fresh result from the session
	const entries = ctx.sessionManager.getBranch();
	const freshResult = findLatestFileList(entries, ctx.cwd);

	if (freshResult) {
		lastFileListResult = freshResult.text;
		lastExtractedPaths = freshResult.paths;
	}

	if (!lastFileListResult) {
		ctx.ui.notify("No assistant response found. Ask something first.", "warning");
		return;
	}

	// Show the action selector
	const action = await showActionSelector(ctx, lastFileListResult, lastExtractedPaths);

	if (!action) {
		// User cancelled - don't show notification
		return;
	}

	switch (action) {
		case "copy":
			// Copy only the extracted file paths, quoted, one per line
			if (lastExtractedPaths.length > 0) {
				const pathsText = lastExtractedPaths.map((p) => `"${p}"`).join("\n");
				await copyToClipboard(pi, ctx, pathsText);
			} else {
				// Fallback to full text if no paths extracted
				await copyToClipboard(pi, ctx, lastFileListResult);
			}
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
		description: "Act on the last assistant result (copy, open files, etc.)",
		handler: async (ctx) => {
			await handleResultAction(pi, ctx);
		},
	});

	// Also register as a command for discoverability
	pi.registerCommand("result-action", {
		description: "Show actions for the last assistant result",
		handler: async (_args, ctx) => {
			await handleResultAction(pi, ctx);
		},
	});

	// Debug command to see what paths are extracted
	pi.registerCommand("result-debug", {
		description: "Debug: show extracted paths from last result",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const result = findLatestFileList(entries, ctx.cwd);

			if (!result) {
				ctx.ui.notify("No assistant response found", "warning");
				return;
			}

			const debugInfo = [
				`Text length: ${result.text.length}`,
				`Paths found: ${result.paths.length}`,
				...result.paths.map((p, i) => `  ${i + 1}. ${p}`),
			].join("\n");

			ctx.ui.notify(result.paths.length > 0 ? `Found ${result.paths.length} paths` : "No paths extracted", "info");

			// Also log to console for detailed debugging
			console.log("=== Result Debug ===");
			console.log(debugInfo);
			console.log("=== First 500 chars of text ===");
			console.log(result.text.slice(0, 500));
		},
	});
}
