import type { Config } from "./config.js";
import { PhpAdapter } from "./adapters/php.js";
import { TypeScriptAdapter } from "./adapters/typescript.js";
import { typeEntryLines } from "./format.js";
import type { AdapterStatus, DescribeResult, ExportsResult, LanguageAdapter, SymbolInfo, UsagesResult } from "./model.js";

const LANGUAGE_ALIASES: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	typescript: "typescript",
	js: "typescript",
	jsx: "typescript",
	javascript: "typescript",
	php: "php",
};

export const LANGUAGES = Object.keys(LANGUAGE_ALIASES);

/** Most hops from a signature to a type in its `types:` section. Also the default `depth`. */
export const MAX_DEPTH = 10;

/**
 * Characters of `types:` text one answer may have; the rest are listed by
 * name only. Measured on 32 answers from two WordPress themes (their own
 * components, their component packages, @wordpress APIs): 29 had at most
 * 1,023 characters of types, SelectControl 6,138 and Button 5,777, and only
 * registerBlockType (17,747 in 29 types) went over this budget.
 */
export const TYPES_BUDGET = 8000;

/**
 * Keep `types:` within the budget. Entries come closest first, and the cut
 * is at the first entry that doesn't fit, so every type nearer the signature
 * than the cut is defined.
 */
function applyTypesBudget(info: SymbolInfo): SymbolInfo {
	if (!info.types?.length) return info;
	let used = 0;
	let cut = info.types.length;
	for (let i = 0; i < info.types.length; i++) {
		used += typeEntryLines(info.types[i], !info.dependency).join("\n").length + 1;
		if (used > TYPES_BUDGET) {
			cut = i;
			break;
		}
	}
	if (cut === info.types.length) return info;
	const omitted = info.types.slice(cut).map((entry) => entry.name);
	return { ...info, types: info.types.slice(0, cut), typesOmitted: [...omitted, ...(info.typesOmitted ?? [])] };
}

export function normalizeLanguage(language: string | undefined): string | undefined {
	if (!language) return undefined;
	const normalized = LANGUAGE_ALIASES[language.toLowerCase()];
	if (!normalized) throw new Error(`Unknown language "${language}". Use one of: ${LANGUAGES.join(", ")}.`);
	return normalized;
}

const FACTORIES: Record<string, (config: Config) => LanguageAdapter> = {
	typescript: (config) => new TypeScriptAdapter(config),
	php: (config) => new PhpAdapter(config),
};

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class Workspace {
	private readonly adapters = new Map<string, LanguageAdapter>();
	private readonly failures = new Map<string, string>();

	constructor(readonly config: Config) {}

	private adapter(language: string): LanguageAdapter | null {
		if (this.adapters.has(language)) return this.adapters.get(language)!;
		if (this.failures.has(language)) return null;
		try {
			const adapter = FACTORIES[language](this.config);
			this.adapters.set(language, adapter);
			return adapter;
		} catch (error) {
			this.failures.set(language, message(error));
			return null;
		}
	}

	private select(language: string | undefined, from: string | undefined, notes: string[]): LanguageAdapter[] {
		const languages = language ? [language] : Object.keys(FACTORIES);
		const out: LanguageAdapter[] = [];
		for (const lang of languages) {
			const adapter = this.adapter(lang);
			if (!adapter) {
				notes.push(`The ${lang} adapter couldn't start: ${this.failures.get(lang)}`);
				continue;
			}
			if (from && !adapter.accepts(from)) continue;
			out.push(adapter);
		}
		return out;
	}

	async describe(query: { name: string; from?: string; language?: string; depth?: number }): Promise<DescribeResult> {
		const language = normalizeLanguage(query.language);
		const notes: string[] = [];
		const chosen = this.select(language, query.from, notes);
		const depth = Math.max(0, Math.min(query.depth ?? MAX_DEPTH, MAX_DEPTH));
		const results = await Promise.all(
			chosen.map((adapter) =>
				adapter.describe(query.name, { from: query.from, depth }).catch((error): SymbolInfo[] => {
					notes.push(`${adapter.language}: ${message(error)}`);
					return [];
				}),
			),
		);
		const matches: SymbolInfo[] = [];
		for (const info of results.flat()) {
			if (info.kind === "unresolved") notes.push(...info.resolution.notes);
			else matches.push(applyTypesBudget(info));
		}

		const alsoDefinedIn = [];
		if (language || query.from) {
			for (const lang of Object.keys(FACTORIES)) {
				const adapter = this.adapter(lang);
				if (!adapter || chosen.includes(adapter)) continue;
				alsoDefinedIn.push(...(await adapter.declarations(query.name).catch(() => [])));
			}
		}
		if (!matches.length) notes.unshift(`No declaration named "${query.name}" was found${query.from ? ` in "${query.from}"` : ""}.`);
		return { query: query.name, matches, alsoDefinedIn, notes: [...new Set(notes)] };
	}

	async exports(query: { target: string; language?: string }): Promise<{ results: ExportsResult[]; notes: string[] }> {
		const language = normalizeLanguage(query.language);
		const notes: string[] = [];
		const results: ExportsResult[] = [];
		for (const adapter of this.select(language, undefined, notes)) {
			try {
				const result = await adapter.exports(query.target);
				if (result) results.push(result);
			} catch (error) {
				notes.push(`${adapter.language}: ${message(error)}`);
			}
		}
		if (!results.length) notes.unshift(`"${query.target}" isn't a file, module or namespace any adapter could read.`);
		return { results, notes };
	}

	async usages(query: { name: string; from?: string; language?: string; limit?: number }): Promise<{ results: UsagesResult[]; notes: string[] }> {
		const language = normalizeLanguage(query.language);
		const notes: string[] = [];
		const limit = Math.max(1, Math.min(query.limit ?? 10, 200));
		const results: UsagesResult[] = [];
		for (const adapter of this.select(language, query.from, notes)) {
			try {
				const result = await adapter.usages(query.name, { from: query.from, limit });
				if (result && (result.total > 0 || result.resolution.notes.length)) results.push(result);
			} catch (error) {
				notes.push(`${adapter.language}: ${message(error)}`);
			}
		}
		const found = results.filter((r) => r.total > 0);
		if (!found.length) notes.unshift(`No usages of "${query.name}" were found.`);
		return { results: found.length ? found : results, notes };
	}

	async status(rootSource = this.config.rootSource): Promise<{ root: string; rootSource: string; include: string[]; exclude: string[]; adapters: AdapterStatus[]; notes: string[] }> {
		const notes: string[] = [];
		const adapters: AdapterStatus[] = [];
		for (const adapter of this.select(undefined, undefined, notes)) {
			try {
				adapters.push(await adapter.status());
			} catch (error) {
				notes.push(`${adapter.language}: ${message(error)}`);
			}
		}
		return { root: this.config.root, rootSource, include: this.config.include, exclude: this.config.exclude, adapters, notes };
	}
}

const workspaces = new Map<string, Workspace>();

export function getWorkspace(config: Config): Workspace {
	const key = JSON.stringify({ root: config.root, include: config.include, exclude: config.exclude });
	let workspace = workspaces.get(key);
	if (!workspace) {
		workspace = new Workspace(config);
		workspaces.set(key, workspace);
	}
	return workspace;
}
