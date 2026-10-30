import type { DescribeResult, ExportsResult, Field, MemberSummary, Resolution, SymbolInfo, TypeEntry, Usage, UsagesResult } from "./model.js";
import { truncate } from "./text.js";

const MAX_DOC = 1500;

/**
 * `locations` is false for symbols from installed packages: the agent needs
 * the import path or qualified name, not where the package's files are.
 * JSON output keeps every location.
 */
function fieldLines(fields: Field[], indent: string, locations = true): string[] {
	const lines: string[] = [];
	for (const field of fields) {
		let line = `${indent}${field.name}${field.optional ? "?" : ""}: ${field.type ?? "(type not declared)"}`;
		if (field.default !== undefined) line += ` = ${field.default}`;
		if (field.doc) line += `  // ${field.doc.replace(/\s*\n\s*/g, " ")}`;
		if (field.declaredIn && locations) line += `  [${field.declaredIn}]`;
		lines.push(line);
		if (field.fields?.length) lines.push(...fieldLines(field.fields, `${indent}    `, locations));
		if (field.inherited?.length) lines.push(...inheritedLines(field.inherited, `${indent}    `, field.type));
	}
	return lines;
}

/**
 * A group named in `shownIn` (the field's type, such as `Props &
 * RefAttributes<HTMLDivElement>`) is left out: the type already says where
 * those props come from. A base type the props interface extends isn't in
 * that text, so its line is the only sign the props exist.
 */
function inheritedLines(inherited: { from: string; count: number }[], indent: string, shownIn?: string): string[] {
	return inherited
		.filter((group) => !shownIn || !namesType(shownIn, group.from))
		.map((group) => `${indent}+ ${group.count} more from ${group.from}`);
}

/** Whether `text` has `name` as a whole type, not as part of a longer name (`Attributes` in `RefAttributes`). */
function namesType(text: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\w$.])${escaped}(?![\\w$<])`).test(text);
}

/**
 * One `types:` entry. An alias prints as `Name = definition`. An object
 * prints on one line, `Name { a: T; b?: U }`, unless a field has a doc, a
 * default or nested fields, or the type has inherited props; then each field
 * gets its own line so the doc and default sit next to it.
 */
export function typeEntryLines(entry: TypeEntry, locations = true): string[] {
	const doc = entry.doc ? `  // ${entry.doc}` : "";
	if (entry.definition !== undefined) return [`  ${entry.name} = ${entry.definition}${doc}`];
	const fields = entry.fields ?? [];
	const plain = !entry.inherited?.length && fields.every((f) => !f.doc && f.default === undefined && !f.fields?.length);
	if (plain) {
		const body = fields.map((f) => `${f.name}${f.optional ? "?" : ""}: ${f.type ?? "unknown"}`).join("; ");
		return [`  ${entry.name} { ${body} }${doc}`];
	}
	return [`  ${entry.name}${doc}`, ...fieldLines(fields, "      ", locations), ...inheritedLines(entry.inherited ?? [], "      ")];
}

function typesLines(info: SymbolInfo, locations: boolean): string[] {
	const lines: string[] = [];
	if (info.types?.length) {
		lines.push("", "types:");
		for (const entry of info.types) lines.push(...typeEntryLines(entry, locations));
	}
	if (info.typesOmitted?.length) {
		if (!info.types?.length) lines.push("");
		lines.push(`not listed (describe them for their fields): ${info.typesOmitted.join(", ")}`);
	}
	return lines;
}

/**
 * Text output says nothing about a result that resolved fully and has no
 * notes. The engine and background info are in the JSON output and `status`.
 */
function resolutionLines(resolution: Resolution): string[] {
	if (resolution.status === "partial") return ["resolution: partial", ...resolution.notes.map((n) => `  - ${n}`)];
	if (resolution.notes.length) return ["notes:", ...resolution.notes.map((n) => `  - ${n}`)];
	return [];
}

function withResolution(lines: string[], resolution: Resolution): string[] {
	const extra = resolutionLines(resolution);
	return extra.length ? [...lines, "", ...extra] : lines;
}

function memberLines(members: MemberSummary[], locations = true): string[] {
	return members.map((m) => {
		let line = `  ${m.name} (${m.kind})`;
		if (m.signature) line += `: ${m.signature}`;
		if (m.summary) line += `  // ${m.summary}`;
		if (m.location && locations) line += `  [${m.location}]`;
		return line;
	});
}

export function formatSymbol(info: SymbolInfo): string {
	const locations = !info.dependency;
	const lines: string[] = [];
	lines.push(`## ${info.qualifiedName ?? info.name} (${info.kind}, ${info.language})`);
	if (locations) lines.push(`at: ${info.location}`);
	if (info.importFrom) lines.push(`import from: "${info.importFrom}"`);
	if (info.source) lines.push(`source: ${info.source}`);
	if (info.doc) lines.push("", truncate(info.doc, MAX_DOC));
	if (info.tags?.length) {
		lines.push("");
		for (const tag of info.tags) lines.push(`@${tag.name}${tag.text ? ` ${tag.text.replace(/\s*\n\s*/g, " ")}` : ""}`);
	}
	for (const sig of info.signatures ?? []) {
		lines.push("", sig.text);
		if (sig.params.length) {
			lines.push("params:");
			lines.push(...fieldLines(sig.params, "  ", locations));
		}
		if (sig.returns?.type || sig.returns?.doc) {
			lines.push(`returns: ${sig.returns.type ?? ""}${sig.returns.doc ? `  // ${sig.returns.doc}` : ""}`);
		}
	}
	if (info.type) lines.push("", `type: ${info.type}`);
	if (info.fields?.length) {
		lines.push("", "fields:");
		lines.push(...fieldLines(info.fields, "  ", locations));
	}
	if (info.inherited?.length) lines.push(...inheritedLines(info.inherited, "  "));
	if (info.members?.length) {
		lines.push("", "members:");
		lines.push(...memberLines(info.members, locations));
	}
	lines.push(...typesLines(info, locations));
	return withResolution(lines, info.resolution).join("\n");
}

export function formatDescribe(result: DescribeResult): string {
	const parts = result.matches.map(formatSymbol);
	const tail: string[] = [];
	if (result.alsoDefinedIn.length) {
		tail.push("also defined in:");
		for (const ref of result.alsoDefinedIn) tail.push(`  ${ref.name} (${ref.kind}, ${ref.language})  [${ref.location}]`);
	}
	if (result.notes.length) {
		tail.push("notes:");
		for (const note of result.notes) tail.push(`  - ${note}`);
	}
	if (tail.length) parts.push(tail.join("\n"));
	return parts.join("\n\n");
}

export function formatExports(results: ExportsResult[], notes: string[]): string {
	const parts = results.map((result) => {
		const lines = [`## ${result.target} (${result.language})${result.location ? `  [${result.location}]` : ""}`];
		lines.push(...memberLines(result.exports));
		if (!result.exports.length) lines.push("  (nothing exported)");
		return withResolution(lines, result.resolution).join("\n");
	});
	if (notes.length) parts.push(["notes:", ...notes.map((n) => `  - ${n}`)].join("\n"));
	return parts.join("\n\n");
}

/**
 * A usage line is `file:line  in Name (kind)  [callback, unconfirmed]`,
 * then the code, then each caller one level deeper as `← file:line  in …`.
 */
function usageLines(usage: Usage, indent: string, top: boolean): string[] {
	let head = `${indent}${top ? "" : "← "}${usage.location}`;
	if (usage.in) head += `  in ${usage.in.name} (${usage.in.kind})`;
	const marks = [usage.callback && "callback", usage.unconfirmed && "unconfirmed"].filter(Boolean);
	if (marks.length) head += `  [${marks.join(", ")}]`;
	if (usage.repeated) head += "  (callers listed elsewhere)";
	const lines = [head];
	if (usage.text) lines.push(...usage.text.split("\n").map((l) => `${indent}  ${l}`));
	for (const caller of usage.callers ?? []) lines.push(...usageLines(caller, `${indent}  `, false));
	if (usage.moreCallers) lines.push(`${indent}  ← ${usage.moreCallers} more`);
	else if (usage.callers && !usage.callers.length) lines.push(`${indent}  ← no usages found`);
	return lines;
}

export function formatUsages(results: UsagesResult[], notes: string[]): string {
	const parts = results.map((result) => {
		const lines = [`## ${result.query} (${result.language}): showing ${result.usages.length} of ${result.total}`];
		for (const usage of result.usages) lines.push("", ...usageLines(usage, "", true));
		return withResolution(lines, result.resolution).join("\n");
	});
	if (notes.length) parts.push(["notes:", ...notes.map((n) => `  - ${n}`)].join("\n"));
	return parts.join("\n\n");
}

export function formatStatus(status: Awaited<ReturnType<import("./workspace.js").Workspace["status"]>>): string {
	const lines = [`root: ${status.root}`, `root from: ${status.rootSource}`];
	if (status.include.length) lines.push(`include: ${status.include.join(", ")}`);
	if (status.exclude.length) lines.push(`exclude: ${status.exclude.join(", ")}`);
	for (const adapter of status.adapters) {
		lines.push("", `## ${adapter.language}: ${adapter.engine}, ${adapter.files} files`);
		for (const note of adapter.notes) lines.push(`  - ${note}`);
	}
	if (status.notes.length) lines.push("", "notes:", ...status.notes.map((n) => `  - ${n}`));
	return lines.join("\n");
}
