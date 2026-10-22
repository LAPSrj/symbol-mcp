import fs from "node:fs";
import path from "node:path";

/**
 * Where to look for code. The root comes from the first of these that is
 * set, highest priority first:
 *
 * - MCP tools:   the `root` argument of a single call
 * - CLI flags:   --root
 * - environment: SYMBOL_MCP_ROOT
 * - MCP client:  the first workspace root the client reports (roots/list)
 * - detection:   the nearest folder at or above the working directory with a
 *                project marker (.git, package.json, composer.json, tsconfig.json, jsconfig.json)
 *
 * Lists (include, exclude) come from SYMBOL_MCP_INCLUDE / SYMBOL_MCP_EXCLUDE
 * or --include / --exclude, comma- or newline-separated. A higher-priority
 * source replaces a list; it doesn't append to it.
 */
export interface Config {
	/** Absolute project root. */
	root: string;
	/** Where the root came from, for status output. */
	rootSource: string;
	/** Extra folders or files to index, absolute. They may be outside the root or ignored by .gitignore. */
	include: string[];
	/** Extra ignore patterns in .gitignore syntax, applied on top of the project's .gitignore files. */
	exclude: string[];
}

export interface ConfigInput {
	root?: string;
	include?: string[];
	exclude?: string[];
	/** Names this input in Config.rootSource when it provides the root. */
	source?: string;
}

const PROJECT_MARKERS = [".git", "package.json", "composer.json", "tsconfig.json", "jsconfig.json"];

/** The nearest folder at or above `start` that has a project marker, or `start` when none does. */
export function detectRoot(start: string = process.cwd()): string {
	let dir = path.resolve(start);
	while (true) {
		if (PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(start);
		dir = parent;
	}
}

export function splitList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(/[,\n]/)
		.map((item) => item.trim())
		.filter(Boolean);
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigInput {
	return {
		root: env.SYMBOL_MCP_ROOT || undefined,
		include: env.SYMBOL_MCP_INCLUDE !== undefined ? splitList(env.SYMBOL_MCP_INCLUDE) : undefined,
		exclude: env.SYMBOL_MCP_EXCLUDE !== undefined ? splitList(env.SYMBOL_MCP_EXCLUDE) : undefined,
		source: "SYMBOL_MCP_ROOT",
	};
}

/** Merge inputs, later ones winning per key, and make every path absolute. */
export function resolveConfig(...inputs: ConfigInput[]): Config {
	let root: string | undefined;
	let rootSource = "";
	let include: string[] = [];
	let exclude: string[] = [];
	for (const input of inputs) {
		if (input.root) {
			root = input.root;
			rootSource = input.source ?? "argument";
		}
		if (input.include) include = input.include;
		if (input.exclude) exclude = input.exclude;
	}
	if (!root) {
		root = detectRoot();
		rootSource = root === process.cwd() ? "working directory" : `nearest project folder above the working directory (${process.cwd()})`;
	}
	const absRoot = path.resolve(root);
	return {
		root: absRoot,
		rootSource,
		include: include.map((item) => path.resolve(absRoot, item)),
		exclude,
	};
}
