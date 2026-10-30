import type { Usage } from "./model.js";

/** A usage, plus a handle on the function or method it's in when that one's own usages can be followed. */
export interface UsageSite<H> {
	usage: Usage;
	caller?: { key: string; handle: H };
}

/**
 * Most usages one answer lists across all levels of a caller tree. A
 * function used from many places grows the tree fast, and past this size
 * the agent is better served by narrowing the query.
 */
export const MAX_TREE_USAGES = 100;

/**
 * Fill in `callers` one level at a time until the tree has `depth` levels.
 * Each function is expanded once; usages in a function already expanded,
 * or in the symbol itself (recursion), get `repeated`. `expanded` starts
 * with the keys of the symbol being searched. Usages below the first level
 * lose their `text`, since the location and the enclosing function are
 * what a caller tree is for.
 */
export function expandCallers<H>(top: UsageSite<H>[], depth: number, limit: number, sitesOf: (handle: H) => UsageSite<H>[], expanded: Set<string>): void {
	let budget = MAX_TREE_USAGES - top.length;
	let level = top;
	for (let d = 2; d <= depth && level.length; d++) {
		const next: UsageSite<H>[] = [];
		for (const site of level) {
			if (!site.caller) continue;
			if (expanded.has(site.caller.key)) {
				site.usage.repeated = true;
				continue;
			}
			expanded.add(site.caller.key);
			const found = sitesOf(site.caller.handle);
			const shown = found.slice(0, Math.max(0, Math.min(limit, budget)));
			budget -= shown.length;
			for (const child of shown) delete child.usage.text;
			site.usage.callers = shown.map((child) => child.usage);
			if (found.length > shown.length) site.usage.moreCallers = found.length - shown.length;
			next.push(...shown);
		}
		level = next;
	}
}
