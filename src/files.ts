import fs from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

/** Directories never walked: version control, and package folders the adapters resolve on their own. */
const ALWAYS_SKIPPED = new Set([".git", ".hg", ".svn", "node_modules"]);

/** Files larger than this are almost always bundles or generated output. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface WalkOptions {
	/** Lowercase extensions including the dot, e.g. [".php"]. */
	extensions: string[];
	/** Extra ignore patterns in .gitignore syntax, relative to the walk root. */
	exclude: string[];
	/** Directory names to skip at any depth, on top of ALWAYS_SKIPPED. */
	skipDirs?: string[];
	/** Respect .gitignore files found during the walk (default true). */
	gitignore?: boolean;
	/** Skip files over the size limit (default true). */
	sizeLimit?: boolean;
}

interface IgnoreLayer {
	base: string;
	matcher: Ignore;
}

function readIgnoreFile(dir: string): Ignore | null {
	const file = path.join(dir, ".gitignore");
	try {
		return ignore().add(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function isIgnored(layers: IgnoreLayer[], absPath: string, isDir: boolean): boolean {
	for (const layer of layers) {
		let rel = path.relative(layer.base, absPath).split(path.sep).join("/");
		if (!rel || rel.startsWith("..")) continue;
		if (isDir) rel += "/";
		if (layer.matcher.ignores(rel)) return true;
	}
	return false;
}

/**
 * List files under `start` (a directory or a single file) with the given
 * extensions, honoring .gitignore files from `start` downwards plus the
 * extra exclude patterns.
 */
export function walk(start: string, options: WalkOptions): string[] {
	const out: string[] = [];
	const extensions = new Set(options.extensions);
	const skip = new Set([...ALWAYS_SKIPPED, ...(options.skipDirs ?? [])]);
	const useGitignore = options.gitignore !== false;
	const sizeLimit = options.sizeLimit !== false;

	let stat: fs.Stats;
	try {
		stat = fs.statSync(start);
	} catch {
		return out;
	}
	if (stat.isFile()) {
		if (extensions.has(extensionOf(start))) out.push(start);
		return out;
	}

	const baseLayers: IgnoreLayer[] = options.exclude.length
		? [{ base: start, matcher: ignore().add(options.exclude) }]
		: [];

	const visit = (dir: string, layers: IgnoreLayer[]) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const own = useGitignore ? readIgnoreFile(dir) : null;
		const active = own ? [...layers, { base: dir, matcher: own }] : layers;
		for (const entry of entries) {
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (skip.has(entry.name)) continue;
				if (isIgnored(active, abs, true)) continue;
				visit(abs, active);
			} else if (entry.isFile()) {
				if (!extensions.has(extensionOf(entry.name))) continue;
				if (isIgnored(active, abs, false)) continue;
				if (sizeLimit) {
					try {
						if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
					} catch {
						continue;
					}
				}
				out.push(abs);
			}
		}
	};
	visit(start, baseLayers);
	return out;
}

export function extensionOf(file: string): string {
	const base = path.basename(file).toLowerCase();
	if (base.endsWith(".d.ts")) return ".ts";
	return path.extname(base);
}

/** Path relative to root with forward slashes, or the absolute path when it's outside the root. */
export function relativeTo(root: string, file: string): string {
	const rel = path.relative(root, file);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return file.split(path.sep).join("/");
	return rel.split(path.sep).join("/");
}

export function readJson<T = unknown>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

export function mtimeOf(file: string): number {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return -1;
	}
}
