const MAX_SNIPPET_LINES = 12;

/** Dedent a code snippet and cut it to a few lines. */
export function trimBlock(text: string, maxLines = MAX_SNIPPET_LINES): string {
	const lines = text.split(/\r?\n/);
	const indents = lines
		.slice(1)
		.filter((l) => l.trim())
		.map((l) => /^\s*/.exec(l)![0].length);
	const cut = indents.length ? Math.min(...indents) : 0;
	const dedented = [lines[0].trim(), ...lines.slice(1).map((l) => l.slice(Math.min(cut, /^\s*/.exec(l)![0].length)).trimEnd())];
	if (dedented.length <= maxLines) return dedented.join("\n");
	return `${dedented.slice(0, maxLines).join("\n")}\n… (${dedented.length - maxLines} more lines)`;
}

export function truncate(text: string, max = 600): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… (${text.length} chars)`;
}

export function firstLine(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const line = text.split(/\r?\n/).find((l) => l.trim());
	return line ? truncate(line.trim(), 200) : undefined;
}

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
