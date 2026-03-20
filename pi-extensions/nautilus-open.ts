/**
 * Nautilus Open Extension
 *
 * Open files in Nautilus with multi-file selection per directory.
 * Uses a companion Nautilus extension (nautilus_select_ext.py) that exposes
 * a custom DBus interface for programmatic multi-select.
 *
 * Files sharing the same parent directory are selected together in one
 * Nautilus window. Files in different directories open separate windows.
 *
 * Commands:
 *   /nautilus-open <file1> [file2] ...  - Open files in Nautilus with selection
 *
 * The extension also exports a function for use by other extensions.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// DBus coordinates — must match the Nautilus extension
const EXT_BUS_NAME = "org.gnome.Nautilus.SelectItems";
const EXT_PATH = "/org/gnome/Nautilus/SelectItems";
const EXT_IFACE = "org.gnome.Nautilus.SelectItems";

const NAUTILUS_BUS = "org.gnome.Nautilus";
const FM_PATH = "/org/freedesktop/FileManager1";
const FM_IFACE = "org.freedesktop.FileManager1";

// Store the pi API for use in exported functions
let piApi: ExtensionAPI | null = null;

/**
 * Convert an absolute path to a file:// URI with proper escaping.
 */
function pathToUri(filePath: string): string {
	// encodeURIComponent encodes too much (including /), so we encode each component
	const parts = filePath.split("/");
	const encoded = parts.map((p) => encodeURIComponent(p)).join("/");
	return `file://${encoded}`;
}

/**
 * Group paths by their parent directory.
 * Returns a Map of directory -> array of file paths.
 */
function groupByDirectory(paths: string[]): Map<string, string[]> {
	const groups = new Map<string, string[]>();

	for (const p of paths) {
		const resolved = path.resolve(p);
		if (!existsSync(resolved)) {
			console.warn(`nautilus-open: skipping non-existent path: ${p}`);
			continue;
		}

		const parent = path.dirname(resolved);
		if (!groups.has(parent)) {
			groups.set(parent, []);
		}
		groups.get(parent)!.push(resolved);
	}

	return groups;
}

/**
 * Check whether the companion Nautilus extension is registered on the bus.
 */
async function extensionAvailable(pi: ExtensionAPI): Promise<boolean> {
	try {
		const result = await pi.exec("gdbus", [
			"call",
			"--session",
			"--dest", "org.freedesktop.DBus",
			"--object-path", "/org/freedesktop/DBus",
			"--method", "org.freedesktop.DBus.NameHasOwner",
			EXT_BUS_NAME,
		]);

		// Result looks like "(true,)" or "(false,)"
		return result.code === 0 && result.stdout?.includes("true");
	} catch {
		return false;
	}
}

/**
 * Wait for the extension to appear on the bus, with timeout.
 */
async function waitForExtension(pi: ExtensionAPI, timeoutMs: number = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (await extensionAvailable(pi)) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}

	return false;
}

/**
 * Start Nautilus if it isn't already running.
 */
async function ensureNautilusRunning(pi: ExtensionAPI): Promise<void> {
	// Start nautilus in service mode (won't open a window)
	// Use spawn to run in background without waiting
	const { spawn } = require("node:child_process");
	spawn("nautilus", ["--gapplication-service"], {
		detached: true,
		stdio: "ignore",
	}).unref();
	// Give it a moment to start
	await new Promise((resolve) => setTimeout(resolve, 500));
}

/**
 * Open a directory in Nautilus via ShowFolders.
 */
async function openFolder(pi: ExtensionAPI, dirUri: string): Promise<boolean> {
	const result = await pi.exec("gdbus", [
		"call",
		"--session",
		"--dest", NAUTILUS_BUS,
		"--object-path", FM_PATH,
		"--method", `${FM_IFACE}.ShowFolders`,
		`['${dirUri}']`,
		"",
	]);

	return result.code === 0;
}

/**
 * Call the extension's Select method to set multi-file selection.
 */
async function selectViaExtension(pi: ExtensionAPI, uris: string[]): Promise<boolean> {
	// Build GVariant array: ['uri1','uri2',...]
	const uriArray = `['${uris.join("','")}']`;

	const result = await pi.exec("gdbus", [
		"call",
		"--session",
		"--dest", EXT_BUS_NAME,
		"--object-path", EXT_PATH,
		"--method", `${EXT_IFACE}.Select`,
		uriArray,
	]);

	return result.code === 0;
}

/**
 * Fallback: use Nautilus's built-in ShowItems (single-select only).
 */
async function showItemsFallback(pi: ExtensionAPI, uris: string[]): Promise<boolean> {
	const uriArray = `['${uris.join("','")}']`;

	const result = await pi.exec("gdbus", [
		"call",
		"--session",
		"--dest", NAUTILUS_BUS,
		"--object-path", FM_PATH,
		"--method", `${FM_IFACE}.ShowItems`,
		uriArray,
		"",
	]);

	return result.code === 0;
}

/**
 * Result of opening files in Nautilus.
 */
export interface NautilusOpenResult {
	success: boolean;
	filesOpened: number;
	directoriesOpened: number;
	hasExtension: boolean;
	errors: string[];
}

/**
 * Open files in Nautilus with multi-file selection support.
 * Files in the same directory will be selected together.
 * Files in different directories will open separate windows.
 *
 * @param paths - Array of file paths to open/select
 * @param pi - ExtensionAPI instance (optional if called after extension init)
 * @returns Result object with success status and details
 */
export async function openInNautilus(
	paths: string[],
	pi?: ExtensionAPI
): Promise<NautilusOpenResult> {
	const api = pi || piApi;
	if (!api) {
		return {
			success: false,
			filesOpened: 0,
			directoriesOpened: 0,
			hasExtension: false,
			errors: ["Extension API not available"],
		};
	}

	const result: NautilusOpenResult = {
		success: false,
		filesOpened: 0,
		directoriesOpened: 0,
		hasExtension: false,
		errors: [],
	};

	// Group files by directory
	const groups = groupByDirectory(paths);
	if (groups.size === 0) {
		result.errors.push("No valid paths provided");
		return result;
	}

	// Ensure Nautilus is running
	await ensureNautilusRunning(api);

	// Check for extension
	result.hasExtension = await waitForExtension(api, 3000);

	if (!result.hasExtension) {
		result.errors.push(
			"nautilus_select_ext not detected — using ShowItems fallback (only one file will be selected per directory)"
		);
	}

	// Process each directory
	for (const [dirPath, filePaths] of groups) {
		const uris = filePaths.map(pathToUri);
		const dirUri = pathToUri(dirPath);

		try {
			if (result.hasExtension) {
				// Open the folder so the extension has a window to work with
				const folderOpened = await openFolder(api, dirUri);
				if (!folderOpened) {
					result.errors.push(`Failed to open folder: ${dirPath}`);
					continue;
				}

				// Wait for folder to load
				await new Promise((resolve) => setTimeout(resolve, 500));

				// Ask the extension to set the selection
				const selected = await selectViaExtension(api, uris);
				if (!selected) {
					result.errors.push(`Failed to select files in: ${dirPath}`);
					continue;
				}
			} else {
				// Fallback to ShowItems
				const shown = await showItemsFallback(api, uris);
				if (!shown) {
					result.errors.push(`Failed to show items in: ${dirPath}`);
					continue;
				}
			}

			result.filesOpened += filePaths.length;
			result.directoriesOpened++;
		} catch (err) {
			result.errors.push(`Error processing ${dirPath}: ${err}`);
		}

		// Small delay between directories to prevent race conditions
		if (groups.size > 1) {
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
	}

	result.success = result.filesOpened > 0;
	return result;
}

export default function (pi: ExtensionAPI): void {
	// Store API for exported function
	piApi = pi;

	// Register /nautilus-open command
	pi.registerCommand("nautilus-open", {
		description: "Open files in Nautilus with multi-file selection",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /nautilus-open <file1> [file2] ...", "warning");
				return;
			}

			// Parse arguments (handle quoted paths)
			const paths = parseArgs(args, ctx.cwd);

			if (paths.length === 0) {
				ctx.ui.notify("No valid file paths provided", "error");
				return;
			}

			ctx.ui.notify(`Opening ${paths.length} file(s) in Nautilus...`, "info");

			const result = await openInNautilus(paths, pi);

			if (result.success) {
				const dirMsg = result.directoriesOpened > 1
					? ` in ${result.directoriesOpened} folders`
					: "";
				const extMsg = result.hasExtension ? "" : " (single-select mode)";
				ctx.ui.notify(
					`Opened ${result.filesOpened} file(s)${dirMsg}${extMsg}`,
					"info"
				);
			} else {
				ctx.ui.notify(
					`Failed to open files: ${result.errors.join("; ")}`,
					"error"
				);
			}
		},
	});

	// Register shortcut for quick access
	pi.registerShortcut("ctrl+shift+n", {
		description: "Open selected/last files in Nautilus",
		handler: async (ctx) => {
			// This could be enhanced to get files from context/selection
			ctx.ui.notify("Use /nautilus-open <files> or Ctrl+Shift+L for result actions", "info");
		},
	});
}

/**
 * Parse command arguments, handling quoted paths and resolving relative paths.
 */
function parseArgs(args: string, cwd: string): string[] {
	const paths: string[] = [];
	const regex = /"([^"]+)"|'([^']+)'|(\S+)/g;
	let match;

	while ((match = regex.exec(args)) !== null) {
		const p = match[1] || match[2] || match[3];
		if (p) {
			// Resolve relative paths
			const resolved = path.isAbsolute(p) ? p : path.resolve(cwd, p);

			// Expand ~ to home directory
			const expanded = resolved.startsWith("~/")
				? path.join(process.env.HOME || "", resolved.slice(2))
				: resolved;

			if (existsSync(expanded)) {
				paths.push(expanded);
			} else {
				console.warn(`nautilus-open: skipping non-existent path: ${p}`);
			}
		}
	}

	return paths;
}
