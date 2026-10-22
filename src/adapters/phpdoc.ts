/**
 * PHPDoc parsing: docblocks, tags (including WordPress-style hash notation
 * for array parameters) and PHPDoc/PHPStan/Psalm type expressions.
 */

export interface DocTag {
	name: string;
	body: string;
}

export interface Docblock {
	summary?: string;
	description?: string;
	tags: DocTag[];
}

/** Split a docblock into summary, description and tags. A tag's body runs until the next tag outside any braces. */
export function parseDocblock(raw: string | undefined): Docblock {
	if (!raw) return { tags: [] };
	const lines = raw
		.replace(/^\/\*\*+/, "")
		.replace(/\*+\/$/, "")
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*\*(?!\/) ?/, "").replace(/\s+$/, ""));

	const text: string[] = [];
	const tags: DocTag[] = [];
	let current: DocTag | null = null;
	let depth = 0;
	for (const line of lines) {
		const tagMatch = /^\s*@([\w-]+(?:\\[\w-]+)*)\s*(.*)$/.exec(line);
		if (tagMatch && depth <= 0) {
			current = { name: tagMatch[1].toLowerCase(), body: tagMatch[2] };
			tags.push(current);
			depth = braceDelta(tagMatch[2]);
			continue;
		}
		if (current) {
			current.body += `\n${line}`;
			depth += braceDelta(line);
		} else {
			text.push(line);
		}
	}
	for (const tag of tags) tag.body = tag.body.trim();

	const joined = text.join("\n").trim();
	const blank = joined.search(/\n\s*\n/);
	const summary = (blank >= 0 ? joined.slice(0, blank) : joined).replace(/\s*\n\s*/g, " ").trim();
	const description = blank >= 0 ? joined.slice(blank).trim() : "";
	return { summary: summary || undefined, description: description || undefined, tags };
}

function braceDelta(text: string): number {
	let delta = 0;
	let quote: string | null = null;
	for (const ch of text) {
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "{") delta++;
		else if (ch === "}") delta--;
	}
	// An unmatched quote (an apostrophe in prose) shouldn't hide braces.
	if (quote) return [...text].reduce((d, c) => d + (c === "{" ? 1 : c === "}" ? -1 : 0), 0);
	return delta;
}

/**
 * Read a type expression from the start of `text` and return it with the
 * rest of the text. Spaces inside brackets belong to the type, and so do
 * spaces around `|`, `&` and after `:` or `,`.
 */
export function readTypeExpression(text: string): { type: string; rest: string } {
	const s = text.trimStart();
	let depth = 0;
	let i = 0;
	let quote: string | null = null;
	for (; i < s.length; i++) {
		const ch = s[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if ("<({[".includes(ch)) depth++;
		else if (">)}]".includes(ch)) {
			// `->` isn't a closing bracket.
			if (ch === ">" && s[i - 1] === "-") continue;
			depth--;
		} else if (/\s/.test(ch) && depth <= 0) {
			const before = s.slice(0, i).trimEnd().slice(-1);
			const after = s.slice(i).trimStart()[0];
			if ("|&:,".includes(before) || (after && "|&".includes(after))) continue;
			break;
		}
	}
	return { type: s.slice(0, i).trim(), rest: s.slice(i).trim() };
}

// ------------------------------------------------------------- type AST

export type TypeNode =
	| { kind: "name"; name: string; generics?: TypeNode[] }
	| { kind: "union"; types: TypeNode[] }
	| { kind: "intersection"; types: TypeNode[] }
	| { kind: "nullable"; type: TypeNode }
	| { kind: "array"; type: TypeNode }
	| { kind: "shape"; base: string; items: ShapeItem[]; sealed: boolean }
	| { kind: "callable"; name: string; params: CallableParam[]; returns?: TypeNode }
	| { kind: "literal"; text: string }
	| { kind: "raw"; text: string };

export interface ShapeItem {
	key?: string;
	optional: boolean;
	type: TypeNode;
}

interface CallableParam {
	type?: TypeNode;
	name?: string;
	byRef?: boolean;
	variadic?: boolean;
	optional?: boolean;
}

const SHAPE_BASES = new Set(["array", "list", "object", "non-empty-array", "non-empty-list"]);
const CALLABLE_NAMES = new Set(["callable", "closure", "\\closure", "pure-callable", "pure-closure"]);

function tokenize(text: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
			tokens.push(text.slice(i, j + 1));
			i = j + 1;
			continue;
		}
		if (text.startsWith("...", i)) {
			tokens.push("...");
			i += 3;
			continue;
		}
		if (/[A-Za-z0-9_\\$\-.]/.test(ch)) {
			let j = i;
			while (j < text.length && /[A-Za-z0-9_\\$\-.*]/.test(text[j])) {
				if (text.startsWith("...", j)) break;
				j++;
			}
			// Class constants: Foo::BAR, self::TYPE_*
			while (text.startsWith("::", j)) {
				j += 2;
				while (j < text.length && /[A-Za-z0-9_*]/.test(text[j])) j++;
			}
			tokens.push(text.slice(i, j));
			i = j;
			continue;
		}
		tokens.push(ch);
		i++;
	}
	return tokens;
}

class TypeParser {
	private pos = 0;
	constructor(private readonly tokens: string[]) {}

	private peek(offset = 0): string | undefined {
		return this.tokens[this.pos + offset];
	}

	private next(): string {
		const token = this.tokens[this.pos++];
		if (token === undefined) throw new Error("unexpected end of type");
		return token;
	}

	private expect(token: string): void {
		const got = this.next();
		if (got !== token) throw new Error(`expected ${token}, got ${got}`);
	}

	done(): boolean {
		return this.pos >= this.tokens.length;
	}

	parseType(): TypeNode {
		const first = this.parseIntersection();
		if (this.peek() !== "|") return first;
		const types = [first];
		while (this.peek() === "|") {
			this.next();
			types.push(this.parseIntersection());
		}
		return { kind: "union", types };
	}

	private parseIntersection(): TypeNode {
		const first = this.parsePostfix();
		// `&` followed by `$` or `...` is a by-reference callable parameter, not an intersection.
		if (this.peek() !== "&" || /^(\$|\.\.\.)/.test(this.peek(1) ?? "")) return first;
		const types = [first];
		while (this.peek() === "&" && !/^(\$|\.\.\.)/.test(this.peek(1) ?? "")) {
			this.next();
			types.push(this.parsePostfix());
		}
		return { kind: "intersection", types };
	}

	private parsePostfix(): TypeNode {
		let node = this.parseAtom();
		while (this.peek() === "[" && this.peek(1) === "]") {
			this.next();
			this.next();
			node = { kind: "array", type: node };
		}
		return node;
	}

	private parseAtom(): TypeNode {
		const token = this.next();
		if (token === "?") return { kind: "nullable", type: this.parsePostfix() };
		if (token === "(") {
			// Conditional types like ($x is int ? A : B) are kept as written.
			if ((this.peek() ?? "").startsWith("$")) return { kind: "raw", text: `(${this.skipBalanced("(", ")")}` };
			const inner = this.parseType();
			this.expect(")");
			return inner;
		}
		if (/^['"]/.test(token) || /^-?\d/.test(token)) return { kind: "literal", text: token };
		if (!/^[A-Za-z_\\$]/.test(token)) throw new Error(`unexpected ${token}`);

		const lower = token.toLowerCase();
		if (this.peek() === "{" && SHAPE_BASES.has(lower)) return this.parseShape(token);
		if (this.peek() === "(" && CALLABLE_NAMES.has(lower)) return this.parseCallable(token);
		if (this.peek() === "<") {
			this.next();
			const generics: TypeNode[] = [];
			while (this.peek() !== ">") {
				if (this.peek() === "*") {
					this.next();
					generics.push({ kind: "name", name: "*" });
				} else {
					generics.push(this.parseType());
				}
				if (this.peek() === ",") this.next();
				else break;
			}
			this.expect(">");
			return { kind: "name", name: token, generics };
		}
		return { kind: "name", name: token };
	}

	private skipBalanced(open: string, close: string): string {
		let depth = 1;
		const parts: string[] = [];
		while (depth > 0) {
			const t = this.next();
			if (t === open) depth++;
			if (t === close) depth--;
			parts.push(t);
		}
		return parts.join(" ");
	}

	private parseShape(base: string): TypeNode {
		this.expect("{");
		const items: ShapeItem[] = [];
		let sealed = true;
		while (this.peek() !== "}") {
			if (this.peek() === "...") {
				this.next();
				sealed = false;
				if (this.peek() === "<") this.skipBalanced(this.next(), ">");
				if (this.peek() === ",") this.next();
				continue;
			}
			let key: string | undefined;
			let optional = false;
			const lookahead = this.peek(1);
			const lookahead2 = this.peek(2);
			if (lookahead === ":" || (lookahead === "?" && lookahead2 === ":")) {
				key = this.next().replace(/^['"]|['"]$/g, "");
				if (this.peek() === "?") {
					this.next();
					optional = true;
				}
				this.expect(":");
			}
			items.push({ key, optional, type: this.parseType() });
			if (this.peek() === ",") this.next();
			else break;
		}
		this.expect("}");
		return { kind: "shape", base, items, sealed };
	}

	private parseCallable(name: string): TypeNode {
		this.expect("(");
		const params: CallableParam[] = [];
		while (this.peek() !== ")") {
			const param: CallableParam = {};
			if (!(this.peek() ?? "").startsWith("$") && this.peek() !== "..." && this.peek() !== "&") param.type = this.parseType();
			if (this.peek() === "&") {
				this.next();
				param.byRef = true;
			}
			if (this.peek() === "...") {
				this.next();
				param.variadic = true;
			}
			if ((this.peek() ?? "").startsWith("$")) param.name = this.next();
			if (this.peek() === "=") {
				this.next();
				param.optional = true;
			}
			params.push(param);
			if (this.peek() === ",") this.next();
			else break;
		}
		this.expect(")");
		let returns: TypeNode | undefined;
		if (this.peek() === ":") {
			this.next();
			returns = this.parsePostfix();
		}
		return { kind: "callable", name, params, returns };
	}
}

export function parseType(text: string): TypeNode {
	try {
		const parser = new TypeParser(tokenize(text));
		const node = parser.parseType();
		if (!parser.done()) return { kind: "raw", text };
		return node;
	} catch {
		return { kind: "raw", text };
	}
}

export function renderType(node: TypeNode): string {
	switch (node.kind) {
		case "name":
			return node.generics ? `${node.name}<${node.generics.map(renderType).join(", ")}>` : node.name;
		case "union":
			return node.types.map(renderType).join("|");
		case "intersection":
			return node.types.map(renderType).join("&");
		case "nullable":
			return `?${renderType(node.type)}`;
		case "array": {
			const inner = renderType(node.type);
			return node.type.kind === "union" || node.type.kind === "intersection" ? `(${inner})[]` : `${inner}[]`;
		}
		case "shape": {
			const items = node.items.map((item) => (item.key !== undefined ? `${item.key}${item.optional ? "?" : ""}: ${renderType(item.type)}` : renderType(item.type)));
			if (!node.sealed) items.push("...");
			return `${node.base}{${items.join(", ")}}`;
		}
		case "callable": {
			const params = node.params.map((p) =>
				[p.type ? renderType(p.type) : "", `${p.byRef ? "&" : ""}${p.variadic ? "..." : ""}${p.name ?? ""}${p.optional ? "=" : ""}`]
					.filter(Boolean)
					.join(" "),
			);
			return `${node.name}(${params.join(", ")})${node.returns ? `: ${renderType(node.returns)}` : ""}`;
		}
		case "literal":
		case "raw":
			return node.text;
	}
}

/** Replace alias names with their definitions. `lookup` returns undefined for names that aren't aliases. */
export function expandAliases(node: TypeNode, lookup: (name: string) => TypeNode | undefined, seen: Set<string> = new Set()): TypeNode {
	const walk = (n: TypeNode): TypeNode => {
		switch (n.kind) {
			case "name": {
				if (!n.generics && !seen.has(n.name)) {
					const target = lookup(n.name);
					if (target) return expandAliases(target, lookup, new Set([...seen, n.name]));
				}
				return n.generics ? { ...n, generics: n.generics.map(walk) } : n;
			}
			case "union":
			case "intersection":
				return { ...n, types: n.types.map(walk) };
			case "nullable":
			case "array":
				return { ...n, type: walk(n.type) };
			case "shape":
				return { ...n, items: n.items.map((item) => ({ ...item, type: walk(item.type) })) };
			case "callable":
				return { ...n, params: n.params.map((p) => ({ ...p, type: p.type && walk(p.type) })), returns: n.returns && walk(n.returns) };
			default:
				return n;
		}
	};
	return walk(node);
}

/** Every plain name a type expression uses (`LinkData`, `Foo` in `list<Foo>`), in order, without repeats. */
export function typeNames(node: TypeNode): string[] {
	const names: string[] = [];
	const walk = (n: TypeNode) => {
		switch (n.kind) {
			case "name":
				if (!names.includes(n.name)) names.push(n.name);
				n.generics?.forEach(walk);
				break;
			case "union":
			case "intersection":
				n.types.forEach(walk);
				break;
			case "nullable":
			case "array":
				walk(n.type);
				break;
			case "shape":
				n.items.forEach((item) => walk(item.type));
				break;
			case "callable":
				n.params.forEach((p) => p.type && walk(p.type));
				if (n.returns) walk(n.returns);
				break;
		}
	};
	walk(node);
	return names;
}

/** The array shape inside a type, if the type is a shape or a nullable/union of one shape and null. */
export function shapeOf(node: TypeNode): Extract<TypeNode, { kind: "shape" }> | undefined {
	if (node.kind === "shape") return node;
	if (node.kind === "nullable") return shapeOf(node.type);
	if (node.kind === "union") {
		const rest = node.types.filter((t) => !(t.kind === "name" && t.name.toLowerCase() === "null"));
		if (rest.length === 1) return shapeOf(rest[0]);
	}
	return undefined;
}

// ------------------------------------------------------------- tags

export interface HashField {
	name: string;
	type?: string;
	doc?: string;
	default?: string;
	fields?: HashField[];
}

export interface ParamTag {
	name: string;
	type?: string;
	doc?: string;
	byRef?: boolean;
	variadic?: boolean;
	/** Keys described with WordPress hash notation: `@param array $args { @type string $key Desc. }` */
	fields?: HashField[];
}

/** Parse the body of @param, @var or @type: `[type] [&][...]$name [description] [{ hash }]`. */
export function parseParamBody(body: string): ParamTag | null {
	let rest = body.trim();
	let type: string | undefined;
	if (!/^(&|\.\.\.)?\$/.test(rest)) {
		const read = readTypeExpression(rest);
		type = read.type || undefined;
		rest = read.rest;
	}
	const nameMatch = /^(&)?(\.\.\.)?\$([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
	if (!nameMatch) {
		// `@var Type` without a variable name.
		return type ? { name: "", type, doc: rest || undefined } : null;
	}
	rest = rest.slice(nameMatch[0].length).trim();
	const tag: ParamTag = { name: `$${nameMatch[3]}`, type, byRef: !!nameMatch[1] || undefined, variadic: !!nameMatch[2] || undefined };

	const open = indexOfTopLevelBrace(rest);
	if (open >= 0) {
		const close = matchingBrace(rest, open);
		const inner = rest.slice(open + 1, close >= 0 ? close : undefined);
		const before = rest.slice(0, open).trim();
		const hash = parseHashBody(inner);
		tag.fields = hash.fields;
		tag.doc = cleanDoc([before, hash.lead].filter(Boolean).join(" ")) || undefined;
	} else {
		tag.doc = cleanDoc(rest) || undefined;
	}
	return tag;
}

function indexOfTopLevelBrace(text: string): number {
	// A brace that starts the hash block, not one inside a description word like `{@see}`.
	const match = /(^|\s)\{(\s|$)/.exec(text);
	return match ? match.index + match[1].length : -1;
}

function matchingBrace(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function parseHashBody(inner: string): { lead: string; fields: HashField[] } {
	const parts: string[] = [];
	let depth = 0;
	let last = 0;
	const re = /@type\b|\{|\}/g;
	let match: RegExpExecArray | null;
	let lead = "";
	let first = true;
	while ((match = re.exec(inner))) {
		if (match[0] === "{") depth++;
		else if (match[0] === "}") depth--;
		else if (depth === 0) {
			if (first) lead = inner.slice(0, match.index);
			else parts.push(inner.slice(last, match.index));
			first = false;
			last = match.index + match[0].length;
		}
	}
	if (first) return { lead: cleanDoc(inner), fields: [] };
	parts.push(inner.slice(last));

	const fields: HashField[] = [];
	for (const part of parts) {
		const tag = parseParamBody(part);
		if (!tag?.name) continue;
		const field: HashField = { name: tag.name.slice(1), type: tag.type, doc: tag.doc, fields: tag.fields };
		const def = defaultFromDoc(tag.doc);
		if (def) field.default = def;
		fields.push(field);
	}
	return { lead: cleanDoc(lead), fields };
}

function cleanDoc(text: string): string {
	return text.replace(/\s*\n\s*/g, " ").trim();
}

/** WordPress-style "Default 'span'." or "Default false." in a description. */
export function defaultFromDoc(doc: string | undefined): string | undefined {
	if (!doc) return undefined;
	const match = /\bDefault(?:s)?(?: is| to)?:?\s+(.+?)(?:\.(?=\s|$)|$)/i.exec(doc);
	if (!match) return undefined;
	const value = match[1].trim();
	// "Default empty." / "Default empty array." read better as written.
	return value.length > 80 ? undefined : value;
}

export interface AliasTag {
	name: string;
	type: string;
}

export interface ImportTag {
	name: string;
	from: string;
	as?: string;
}

/** `@phpstan-type Name = Type`, `@phpstan-type Name Type`, and the psalm form. */
export function parseAliasTag(body: string): AliasTag | null {
	const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(=\s*)?([\s\S]+)$/.exec(body.trim());
	if (!match) return null;
	return { name: match[1], type: match[3].trim() };
}

/** `@phpstan-import-type Name from Class [as Local]`. */
export function parseImportTag(body: string): ImportTag | null {
	const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+from\s+(\\?[A-Za-z_][A-Za-z0-9_\\]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/.exec(body.trim());
	if (!match) return null;
	return { name: match[1], from: match[2], as: match[3] };
}
