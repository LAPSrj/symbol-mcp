import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node, type Tree } from "web-tree-sitter";
import { expandCallers, type UsageSite } from "../callers.js";
import type { Config } from "../config.js";
import { walk, relativeTo, readJson, mtimeOf } from "../files.js";
import type {
	AdapterStatus,
	DeclarationRef,
	DescribeOptions,
	ExportsResult,
	Field,
	LanguageAdapter,
	MemberSummary,
	Resolution,
	Signature,
	SymbolInfo,
	TypeEntry,
	Usage,
	UsagesOptions,
	UsagesResult,
} from "../model.js";
import { escapeRegExp, firstLine, trimBlock, truncate } from "../text.js";
import {
	defaultFromDoc,
	parseAliasTag,
	parseDocblock,
	parseImportTag,
	parseParamBody,
	parseType,
	renderType,
	shapeOf,
	typeNames,
	type Docblock,
	type HashField,
	type ParamTag,
	type TypeNode,
} from "./phpdoc.js";

const ENGINE = "tree-sitter-php";
const MAX_MATCHES = 10;

// ------------------------------------------------------------- parser

let parserPromise: Promise<Parser> | null = null;

function grammarPath(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.resolve(here, "../../grammars/tree-sitter-php.wasm"),
		path.resolve(here, "../../node_modules/tree-sitter-php/tree-sitter-php.wasm"),
	];
	const found = candidates.find((file) => fs.existsSync(file));
	if (!found) throw new Error(`The PHP grammar (tree-sitter-php.wasm) is missing. Looked in: ${candidates.join(", ")}`);
	return found;
}

function getParser(): Promise<Parser> {
	parserPromise ??= (async () => {
		await Parser.init();
		const language = await Language.load(grammarPath());
		const parser = new Parser();
		parser.setLanguage(language);
		return parser;
	})();
	return parserPromise;
}

// -------------------------------------------------------------- index

interface PhpParam {
	name: string;
	type?: string;
	default?: string;
	byRef?: boolean;
	variadic?: boolean;
	promoted?: string;
}

type DeclKind = "function" | "class" | "interface" | "trait" | "enum" | "method" | "property" | "constant" | "case" | "file";

interface PhpDecl {
	kind: DeclKind;
	name: string;
	fqn: string;
	file: string;
	line: number;
	namespace: string;
	/** Lowercase alias → fully qualified class name, from `use` statements. */
	uses: Record<string, string>;
	doc?: string;
	modifiers: string[];
	params: PhpParam[];
	returnType?: string;
	signature: string;
	extends: string[];
	implements: string[];
	/** Traits a class uses, fully qualified. */
	traits?: string[];
	members: PhpDecl[];
	owner?: PhpDecl;
	/** Parameter variable → array key → default, read from `$param['key'] ?? default` and similar code. */
	bodyDefaults: Record<string, Record<string, string>>;
	type?: string;
	value?: string;
}

interface FileEntry {
	mtime: number;
	decls: PhpDecl[];
}

function lineOf(node: Node): number {
	return node.startPosition.row + 1;
}

function squash(text: string): string {
	return text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/,\s*\)/g, ")").trim();
}

function stringValue(node: Node | null): string | undefined {
	if (!node) return undefined;
	if (node.type === "string" || node.type === "encapsed_string") {
		const content = node.namedChildren.filter((c) => c?.type === "string_content" || c?.type === "string_value");
		if (content.length) return content.map((c) => c!.text).join("");
		return node.text.replace(/^['"]|['"]$/g, "");
	}
	return undefined;
}

function docFor(node: Node): string | undefined {
	let prev = node.previousNamedSibling;
	for (let i = 0; prev && i < 3; i++, prev = prev.previousNamedSibling) {
		if (prev.type !== "comment") break;
		if (prev.text.startsWith("/**")) return prev.text;
	}
	// `/** doc */ if ( ! function_exists( 'x' ) ) { function x() {} }`
	let parent = node.parent;
	for (let i = 0; parent && i < 3; i++, parent = parent.parent) {
		if (parent.type === "if_statement") return docFor(parent);
		if (parent.type === "program" || parent.type === "declaration_list") break;
	}
	return undefined;
}

class Extractor {
	private namespace = "";
	private uses: Record<string, string> = {};
	readonly decls: PhpDecl[] = [];

	constructor(private readonly file: string) {}

	run(root: Node): void {
		this.visit(root);
		const topLevel = this.decls.filter((d) => d.kind !== "constant");
		if (!topLevel.length) this.decls.push(this.fileDecl(root));
	}

	private resolveName(name: string): string {
		if (name.startsWith("\\")) return name.slice(1);
		const [first, ...rest] = name.split("\\");
		const lower = first.toLowerCase();
		if (["self", "static", "parent", "array", "string", "int", "float", "bool", "mixed", "void", "null", "callable", "iterable", "object", "never", "false", "true"].includes(lower) && !rest.length) {
			return name;
		}
		const used = this.uses[lower];
		if (used) return [used, ...rest].join("\\");
		return this.namespace ? `${this.namespace}\\${name}` : name;
	}

	private visit(node: Node): void {
		for (const child of node.namedChildren) {
			if (!child) continue;
			switch (child.type) {
				case "namespace_definition": {
					const name = child.childForFieldName("name")?.text ?? "";
					const body = child.childForFieldName("body");
					if (body) {
						const saved = [this.namespace, this.uses] as const;
						this.namespace = name;
						this.uses = {};
						this.visit(body);
						[this.namespace, this.uses] = saved;
					} else {
						this.namespace = name;
						this.uses = {};
					}
					break;
				}
				case "namespace_use_declaration":
					this.readUses(child);
					break;
				case "function_definition":
					this.decls.push(this.functionDecl(child, "function"));
					break;
				case "class_declaration":
				case "interface_declaration":
				case "trait_declaration":
				case "enum_declaration":
					this.decls.push(this.classDecl(child));
					break;
				case "const_declaration":
					for (const decl of this.constDecls(child, undefined)) this.decls.push(decl);
					break;
				case "anonymous_function":
				case "arrow_function":
				case "method_declaration":
					break;
				default:
					if (child.namedChildCount) this.visit(child);
			}
		}
	}

	private readUses(node: Node): void {
		const declType = node.namedChildren.find((c) => c?.type === "function" || c?.type === "const") ? "other" : "class";
		const group = node.namedChildren.find((c) => c?.type === "namespace_use_group");
		const prefixNode = node.namedChildren.find((c) => c?.type === "namespace_name");
		const prefix = group && prefixNode ? `${prefixNode.text}\\` : "";
		const clauses = (group ?? node).namedChildren.filter((c) => c?.type === "namespace_use_clause" || c?.type === "namespace_use_group_clause");
		for (const clause of clauses) {
			if (!clause) continue;
			const clauseType = clause.childForFieldName("type")?.text;
			if (declType !== "class" || clauseType === "function" || clauseType === "const") continue;
			const nameNode = clause.namedChildren.find((c) => c?.type === "qualified_name" || c?.type === "name" || c?.type === "namespace_name");
			if (!nameNode) continue;
			const full = `${prefix}${nameNode.text}`.replace(/^\\/, "");
			const alias = clause.childForFieldName("alias")?.text ?? full.split("\\").pop()!;
			this.uses[alias.toLowerCase()] = full;
		}
	}

	private params(node: Node | null): PhpParam[] {
		if (!node) return [];
		const out: PhpParam[] = [];
		for (const param of node.namedChildren) {
			if (!param || !/parameter$/.test(param.type)) continue;
			const name = param.childForFieldName("name")?.text;
			if (!name) continue;
			out.push({
				name,
				type: param.childForFieldName("type")?.text,
				default: param.childForFieldName("default_value")?.text,
				byRef: param.namedChildren.some((c) => c?.type === "reference_modifier") || undefined,
				variadic: param.type === "variadic_parameter" || undefined,
				promoted: param.type === "property_promotion_parameter" ? param.childForFieldName("visibility")?.text ?? "public" : undefined,
			});
		}
		return out;
	}

	private modifiers(node: Node): string[] {
		return node.namedChildren
			.filter((c) => c && /_modifier$/.test(c.type) && c.type !== "reference_modifier")
			.map((c) => c!.text.toLowerCase());
	}

	private functionDecl(node: Node, kind: "function" | "method", owner?: PhpDecl): PhpDecl {
		const name = node.childForFieldName("name")?.text ?? "";
		const params = this.params(node.childForFieldName("parameters"));
		const returnType = node.childForFieldName("return_type")?.text;
		const modifiers = this.modifiers(node);
		const paramsText = squash(node.childForFieldName("parameters")?.text ?? "()");
		const prefix = [...modifiers, "function"].join(" ");
		const body = node.childForFieldName("body");
		return {
			kind,
			name,
			fqn: owner ? `${owner.fqn}::${name}` : this.namespace ? `${this.namespace}\\${name}` : name,
			file: this.file,
			line: lineOf(node),
			namespace: this.namespace,
			uses: { ...this.uses },
			doc: docFor(node),
			modifiers,
			params,
			returnType,
			signature: `${prefix} ${name}${paramsText}${returnType ? `: ${returnType}` : ""}`,
			extends: [],
			implements: [],
			members: [],
			owner,
			bodyDefaults: body ? bodyDefaults(body, new Set(params.map((p) => p.name))) : {},
		};
	}

	private classDecl(node: Node): PhpDecl {
		const kind = node.type.replace(/_declaration$/, "") as DeclKind;
		const name = node.childForFieldName("name")?.text ?? "";
		const extendsNames: string[] = [];
		const implementsNames: string[] = [];
		for (const child of node.namedChildren) {
			if (!child) continue;
			const names = child.namedChildren.filter((c) => c?.type === "name" || c?.type === "qualified_name").map((c) => this.resolveName(c!.text));
			if (child.type === "base_clause") extendsNames.push(...names);
			if (child.type === "class_interface_clause") implementsNames.push(...names);
		}
		const modifiers = this.modifiers(node);
		const decl: PhpDecl = {
			kind,
			name,
			fqn: this.namespace ? `${this.namespace}\\${name}` : name,
			file: this.file,
			line: lineOf(node),
			namespace: this.namespace,
			uses: { ...this.uses },
			doc: docFor(node),
			modifiers,
			params: [],
			signature: [
				...modifiers,
				kind,
				name,
				extendsNames.length ? `extends ${extendsNames.join(", ")}` : "",
				implementsNames.length ? `implements ${implementsNames.join(", ")}` : "",
			]
				.filter(Boolean)
				.join(" "),
			extends: extendsNames,
			implements: implementsNames,
			members: [],
			bodyDefaults: {},
		};
		const body = node.childForFieldName("body");
		for (const member of body?.namedChildren ?? []) {
			if (!member) continue;
			if (member.type === "use_declaration") {
				const traits = member.namedChildren.filter((c) => c?.type === "name" || c?.type === "qualified_name").map((c) => this.resolveName(c!.text));
				decl.traits = [...(decl.traits ?? []), ...traits];
			} else if (member.type === "method_declaration") {
				const method = this.functionDecl(member, "method", decl);
				decl.members.push(method);
				if (method.name.toLowerCase() === "__construct") {
					decl.params = method.params;
					decl.bodyDefaults = method.bodyDefaults;
				}
			} else if (member.type === "property_declaration") {
				const modifiersOfProp = this.modifiers(member);
				const type = member.childForFieldName("type")?.text;
				for (const element of member.namedChildren.filter((c) => c?.type === "property_element")) {
					const propName = element!.childForFieldName("name")?.text ?? element!.namedChildren[0]?.text ?? "";
					decl.members.push({
						...this.memberBase(member, decl),
						kind: "property",
						name: propName,
						fqn: `${decl.fqn}::${propName}`,
						modifiers: modifiersOfProp,
						type,
						value: element!.childForFieldName("default_value")?.text,
						signature: [...modifiersOfProp, type, propName].filter(Boolean).join(" "),
					});
				}
			} else if (member.type === "const_declaration") {
				decl.members.push(...this.constDecls(member, decl));
			} else if (member.type === "enum_case") {
				const caseName = member.childForFieldName("name")?.text ?? "";
				const value = member.childForFieldName("value")?.text;
				decl.members.push({
					...this.memberBase(member, decl),
					kind: "case",
					name: caseName,
					fqn: `${decl.fqn}::${caseName}`,
					value,
					signature: `case ${caseName}${value ? ` = ${value}` : ""}`,
				});
			}
		}
		for (const method of decl.members) {
			if (method.kind === "method" && method.name.toLowerCase() === "__construct") {
				for (const param of method.params.filter((p) => p.promoted)) {
					decl.members.push({
						...this.memberBase(body ?? node, decl),
						kind: "property",
						name: param.name,
						fqn: `${decl.fqn}::${param.name}`,
						modifiers: [param.promoted!],
						type: param.type,
						line: method.line,
						signature: [param.promoted, param.type, param.name].filter(Boolean).join(" "),
					});
				}
			}
		}
		return decl;
	}

	private memberBase(node: Node, owner: PhpDecl): PhpDecl {
		return {
			kind: "property",
			name: "",
			fqn: "",
			file: this.file,
			line: lineOf(node),
			namespace: this.namespace,
			uses: owner.uses,
			doc: docFor(node),
			modifiers: [],
			params: [],
			signature: "",
			extends: [],
			implements: [],
			members: [],
			owner,
			bodyDefaults: {},
		};
	}

	private constDecls(node: Node, owner: PhpDecl | undefined): PhpDecl[] {
		const modifiers = this.modifiers(node);
		return node.namedChildren
			.filter((c) => c?.type === "const_element")
			.map((element) => {
				const name = element!.namedChildren.find((c) => c?.type === "name")?.text ?? "";
				const value = element!.namedChildren.filter((c) => c?.type !== "name").map((c) => c!.text).join(" ") || undefined;
				return {
					kind: "constant" as const,
					name,
					fqn: owner ? `${owner.fqn}::${name}` : this.namespace ? `${this.namespace}\\${name}` : name,
					file: this.file,
					line: lineOf(node),
					namespace: this.namespace,
					uses: { ...this.uses },
					doc: docFor(node),
					modifiers,
					params: [],
					signature: `${[...modifiers, "const"].join(" ")} ${name}${value ? ` = ${truncate(squash(value), 200)}` : ""}`,
					extends: [],
					implements: [],
					members: [],
					owner,
					value,
					bodyDefaults: {},
				};
			});
	}

	/** A file without classes or functions, such as a template that reads variables passed to it. */
	private fileDecl(root: Node): PhpDecl {
		const name = path.basename(this.file).replace(/\.php$/i, "");
		const doc = root.namedChildren.slice(0, 4).find((c) => c?.type === "comment" && c.text.startsWith("/**"))?.text;
		const docblock = parseDocblock(doc);
		const vars = new Set<string>();
		for (const tag of docblock.tags) {
			if (tag.name === "var" || tag.name === "param") {
				const parsed = parseParamBody(tag.body);
				if (parsed?.name) vars.add(parsed.name);
			}
		}
		return {
			kind: "file",
			name,
			fqn: name,
			file: this.file,
			line: 1,
			namespace: this.namespace,
			uses: { ...this.uses },
			doc,
			modifiers: [],
			params: [],
			signature: `file ${name}.php`,
			extends: [],
			implements: [],
			members: [],
			bodyDefaults: bodyDefaults(root, vars.size ? vars : null),
		};
	}
}

/**
 * Defaults for array keys, read from code that does
 * `$args['key'] ?? default`, `isset( $args['key'] ) ? $args['key'] : default`,
 * or merges `$args` with a literal array of defaults. A merge is recognized
 * by its shape, not the function's name: `$args = anything( $args, [ … ] )`
 * or `return anything( $args, [ … ] )`.
 * `vars` limits it to those variables; null means any variable.
 */
function bodyDefaults(body: Node, vars: Set<string> | null): Record<string, Record<string, string>> {
	const out: Record<string, Record<string, string>> = {};
	const record = (variable: string, key: string, value: string) => {
		if (vars && !vars.has(variable)) return;
		out[variable] ??= {};
		out[variable][key] ??= truncate(squash(value), 120);
	};
	const subscript = (node: Node | null): { variable: string; key: string } | null => {
		if (!node || node.type !== "subscript_expression") return null;
		const target = node.namedChildren[0];
		const index = node.namedChildren[1];
		if (target?.type !== "variable_name") return null;
		const key = stringValue(index ?? null);
		return key !== undefined ? { variable: target.text, key } : null;
	};
	const arrays = new Map<string, Node>();

	for (const assignment of body.descendantsOfType("assignment_expression")) {
		const left = assignment?.childForFieldName("left");
		const right = assignment?.childForFieldName("right");
		if (left?.type === "variable_name" && right?.type === "array_creation_expression") arrays.set(left.text, right);
	}
	const literalPairs = (node: Node): [string, string][] => {
		const pairs: [string, string][] = [];
		for (const element of node.namedChildren) {
			if (element?.type !== "array_element_initializer" || element.namedChildCount !== 2) continue;
			const key = stringValue(element.namedChildren[0]);
			if (key !== undefined) pairs.push([key, element.namedChildren[1]!.text]);
		}
		return pairs;
	};

	for (const node of body.descendantsOfType(["binary_expression", "conditional_expression", "function_call_expression", "member_call_expression", "scoped_call_expression"])) {
		if (!node) continue;
		if (node.type === "binary_expression") {
			if (node.child(1)?.text !== "??") continue;
			const sub = subscript(node.childForFieldName("left"));
			const right = node.childForFieldName("right");
			if (sub && right) record(sub.variable, sub.key, right.text);
		} else if (node.type === "conditional_expression") {
			const condition = node.childForFieldName("condition");
			if (condition?.type !== "function_call_expression" || condition.childForFieldName("function")?.text !== "isset") continue;
			const arg = condition.childForFieldName("arguments")?.namedChildren[0]?.namedChildren[0] ?? null;
			const sub = subscript(arg);
			const alternative = node.childForFieldName("alternative");
			if (sub && alternative) record(sub.variable, sub.key, alternative.text);
		} else {
			const parent = node.parent;
			const assignedTo = parent?.type === "assignment_expression" && parent.childForFieldName("right")?.id === node.id ? parent.childForFieldName("left")?.text : undefined;
			const returned = parent?.type === "return_statement";
			if (!assignedTo && !returned) continue;
			const args = (node.childForFieldName("arguments")?.namedChildren ?? []).map((a) => a?.namedChildren[0] ?? a).filter(Boolean) as Node[];
			const variable = args.find((a) => a.type === "variable_name" && (returned || a.text === assignedTo) && (!vars || vars.has(a.text)) && !arrays.has(a.text));
			const defaults = args.find((a) => a !== variable && (a.type === "array_creation_expression" || (a.type === "variable_name" && arrays.has(a.text))));
			if (!variable || !defaults) continue;
			const literal = defaults.type === "array_creation_expression" ? defaults : arrays.get(defaults.text)!;
			for (const [key, value] of literalPairs(literal)) record(variable.text, key, value);
		}
	}
	return out;
}

// ------------------------------------------------------------ adapter

interface ComposerInfo {
	vendorDir: string;
	installed: boolean;
	autoloadPaths: string[];
	notes: string[];
}

function readComposer(root: string): ComposerInfo {
	const composer = readJson<{ config?: { "vendor-dir"?: string }; require?: Record<string, string>; "require-dev"?: Record<string, string> }>(path.join(root, "composer.json"));
	const vendorDir = path.resolve(root, composer?.config?.["vendor-dir"] ?? "vendor");
	const notes: string[] = [];
	const installedFile = path.join(vendorDir, "composer", "installed.json");
	const installedJson = readJson<{ packages?: ComposerPackage[] } | ComposerPackage[]>(installedFile);
	const autoloadPaths: string[] = [];
	if (installedJson) {
		const packages = Array.isArray(installedJson) ? installedJson : installedJson.packages ?? [];
		for (const pkg of packages) {
			const base = pkg["install-path"] ? path.resolve(path.dirname(installedFile), pkg["install-path"]) : path.join(vendorDir, pkg.name);
			const autoload = pkg.autoload ?? {};
			for (const section of [autoload["psr-4"], autoload["psr-0"]]) {
				for (const dirs of Object.values(section ?? {})) {
					for (const dir of Array.isArray(dirs) ? dirs : [dirs]) autoloadPaths.push(path.resolve(base, dir));
				}
			}
			for (const entry of [...(autoload.classmap ?? []), ...(autoload.files ?? [])]) autoloadPaths.push(path.resolve(base, entry));
		}
	} else {
		const deps = Object.keys({ ...composer?.require, ...composer?.["require-dev"] }).filter((d) => d !== "php" && !d.startsWith("ext-"));
		if (deps.length) {
			notes.push(`${relativeTo(root, vendorDir)}/ isn't installed (no composer/installed.json), so classes from Composer packages can't be resolved. Run composer install to describe them.`);
		}
	}
	return { vendorDir, installed: !!installedJson, autoloadPaths, notes };
}

interface ComposerPackage {
	name: string;
	"install-path"?: string;
	autoload?: {
		"psr-4"?: Record<string, string | string[]>;
		"psr-0"?: Record<string, string | string[]>;
		classmap?: string[];
		files?: string[];
	};
}

// ------------------------------------------------------ usage helpers

/** Namespace and `use` imports in effect over a range of a file. */
interface NameScope {
	start: number;
	end: number;
	namespace: string;
	/** Lowercase alias → fully qualified name, for classes and namespaces. */
	classes: Map<string, string>;
	/** Lowercase alias → fully qualified name, from `use function`. */
	functions: Map<string, string>;
}

/** A file parsed for one request. */
interface ParsedFile {
	file: string;
	text: string;
	tree: Tree;
	scopes: NameScope[];
}

/** Where a node is: its file, the names in scope, and the class it's inside. */
interface Where {
	parsed: ParsedFile;
	scope: NameScope;
	self?: string;
}

interface Match {
	node: Node;
	callback?: boolean;
	unconfirmed?: boolean;
}

const CLASS_LIKE = new Set(["class_declaration", "interface_declaration", "trait_declaration", "enum_declaration"]);
const FUNCTION_LIKE = new Set(["function_definition", "method_declaration", "anonymous_function", "arrow_function"]);
/** Calls that take a function's name to check that it exists, not to call it. */
const EXISTENCE_CHECKS = new Set(["function_exists"]);
const SCALAR_TYPES = new Set([
	"array", "string", "int", "integer", "float", "double", "bool", "boolean", "false", "true", "null", "void", "mixed", "never",
	"callable", "iterable", "object", "resource", "scalar", "numeric", "array-key", "list", "non-empty-array", "non-empty-list",
	"non-empty-string", "positive-int", "negative-int", "class-string", "callable-string", "parent",
]);

/** Texts and trees read during one request, so a caller tree reads each file once. */
class FileCache {
	private readonly texts = new Map<string, string | null>();
	private readonly parsed = new Map<string, ParsedFile | null>();

	constructor(readonly parser: Parser) {}

	text(file: string): string | null {
		if (!this.texts.has(file)) {
			try {
				this.texts.set(file, fs.readFileSync(file, "utf8"));
			} catch {
				this.texts.set(file, null);
			}
		}
		return this.texts.get(file)!;
	}

	parse(file: string): ParsedFile | null {
		if (!this.parsed.has(file)) {
			const text = this.text(file);
			const tree = text === null ? null : this.parser.parse(text);
			this.parsed.set(file, tree && text !== null ? { file, text, tree, scopes: nameScopes(tree.rootNode, text.length) } : null);
		}
		return this.parsed.get(file)!;
	}

	dispose(): void {
		for (const parsed of this.parsed.values()) parsed?.tree.delete();
	}
}

function emptyScope(): NameScope {
	return { start: 0, end: Infinity, namespace: "", classes: new Map(), functions: new Map() };
}

function readUseDeclaration(node: Node, scope: NameScope): void {
	const declType = node.childForFieldName("type")?.text;
	const group = node.childForFieldName("body");
	const prefixNode = group ? node.namedChildren.find((c) => c?.type === "namespace_name" || c?.type === "qualified_name" || c?.type === "name") : null;
	const prefix = prefixNode ? `${prefixNode.text.replace(/^\\/, "")}\\` : "";
	for (const clause of (group ?? node).namedChildren) {
		if (clause?.type !== "namespace_use_clause" && clause?.type !== "namespace_use_group_clause") continue;
		const type = clause.childForFieldName("type")?.text ?? declType;
		const nameNode = clause.namedChildren.find((c) => c?.type === "qualified_name" || c?.type === "name" || c?.type === "namespace_name");
		if (!nameNode) continue;
		const full = `${prefix}${nameNode.text}`.replace(/^\\/, "");
		const alias = (clause.childForFieldName("alias")?.text ?? full.split("\\").pop()!).toLowerCase();
		if (type === "function") scope.functions.set(alias, full);
		else if (type !== "const") scope.classes.set(alias, full);
	}
}

/** One scope per namespace block, braced (`namespace A { }`) or not (`namespace A;`). */
function nameScopes(root: Node, length: number): NameScope[] {
	let current: NameScope = { ...emptyScope(), end: length };
	const scopes = [current];
	for (const child of root.namedChildren) {
		if (child?.type === "namespace_use_declaration") readUseDeclaration(child, current);
		if (child?.type !== "namespace_definition") continue;
		const namespace = child.childForFieldName("name")?.text ?? "";
		const body = child.childForFieldName("body");
		if (body) {
			const scope: NameScope = { ...emptyScope(), start: body.startIndex, end: body.endIndex, namespace };
			for (const inner of body.namedChildren) if (inner?.type === "namespace_use_declaration") readUseDeclaration(inner, scope);
			scopes.push(scope);
		} else {
			current.end = child.startIndex;
			current = { ...emptyScope(), start: child.startIndex, end: length, namespace };
			scopes.push(current);
		}
	}
	return scopes;
}

function scopeAt(scopes: NameScope[], pos: number): NameScope {
	for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].start <= pos && pos < scopes[i].end) return scopes[i];
	return scopes[0];
}

/** PHP's rule for a class name: a leading `\` is absolute, then `use` imports, then the current namespace. */
function resolveClassIn(scope: NameScope, name: string): string {
	if (name.startsWith("\\")) return name.slice(1);
	if (/^namespace\\/i.test(name)) return [scope.namespace, name.slice(10)].filter(Boolean).join("\\");
	const [first, ...rest] = name.split("\\");
	const used = scope.classes.get(first.toLowerCase());
	if (used) return [used, ...rest].join("\\");
	return scope.namespace ? `${scope.namespace}\\${name}` : name;
}

/** Class names in a native or PHPDoc type (`?Foo`, `Foo|Bar`, `Collection<Foo>`); null when there are none. */
function classesOfType(text: string | undefined, resolve: (name: string) => string, self: string | undefined): string[] | null {
	if (!text) return null;
	const out: string[] = [];
	for (const raw of text.replace(/[()]/g, " ").split(/[|&]/)) {
		const part = raw.trim().replace(/^\?/, "");
		if (!part || part.endsWith("]")) continue;
		const base = part.replace(/[<{].*$/s, "").trim();
		const lower = base.toLowerCase();
		if (lower === "self" || lower === "static" || lower === "$this") {
			if (self) out.push(self);
		} else if (!SCALAR_TYPES.has(lower) && /^\\?[A-Za-z_][\w\\]*$/.test(base)) {
			out.push(resolve(base));
		}
	}
	return out.length ? [...new Set(out)] : null;
}

function lastSegment(name: string): string {
	return name.slice(name.lastIndexOf("\\") + 1);
}

function enclosingFunction(node: Node): Node | null {
	for (let current = node.parent; current; current = current.parent) if (FUNCTION_LIKE.has(current.type)) return current;
	return null;
}

function closureUses(fn: Node, name: string): boolean {
	const clause = fn.namedChildren.find((c) => c?.type === "anonymous_function_use_clause");
	return !!clause?.descendantsOfType("variable_name").some((v) => v.text === name);
}

/** `$x` for a statement `$x = …;`. */
function assignedVariable(node: Node | null): string | undefined {
	const assignment = node?.type === "expression_statement" ? node.namedChildren[0] : null;
	return assignment?.type === "assignment_expression" ? assignment.childForFieldName("left")?.text : undefined;
}

/**
 * The function or `Class::method` a string names, as PHP reads a callable
 * string: always fully qualified, so `'setup'` is the global function, and
 * `__NAMESPACE__ . '\setup'` is the one in the current namespace.
 */
function callableName(str: Node, scope: NameScope): string | undefined {
	const raw = str.text.slice(1, -1).replace(/\\\\/g, "\\");
	if (!/^\\?[A-Za-z_][\w\\]*(::[A-Za-z_]\w*)?$/.test(raw)) return undefined;
	const parent = str.parent;
	if (parent?.type === "binary_expression" && parent.childForFieldName("right")?.id === str.id && parent.childForFieldName("left")?.text === "__NAMESPACE__") {
		return `${scope.namespace}\\${raw.replace(/^\\/, "")}`.replace(/^\\/, "");
	}
	return raw.replace(/^\\/, "");
}

/** Whether a node is an argument of a call to one of `names`. */
function insideCallTo(node: Node, names: Set<string>): boolean {
	const call = node.parent?.type === "argument" ? node.parent.parent?.parent : null;
	const fn = call?.type === "function_call_expression" ? call.childForFieldName("function")?.text : undefined;
	return !!fn && names.has(fn.replace(/^\\/, "").toLowerCase());
}

/** Whether a `name` or `qualified_name` node refers to a class, rather than declaring something or naming a function, member or constant. */
function isClassReference(node: Node): boolean {
	const parent = node.parent;
	if (!parent) return false;
	if (["variable_name", "qualified_name", "namespace_name", "namespace_use_clause", "namespace_use_group_clause", "namespace_definition", "const_element"].includes(parent.type)) return false;
	if (parent.childForFieldName("name")?.id === node.id) return false;
	if (parent.type === "function_call_expression" && parent.childForFieldName("function")?.id === node.id) return false;
	if (parent.type === "class_constant_access_expression" && parent.namedChildren[1]?.id === node.id) return false;
	return true;
}

const CONFIG_EXTENSIONS = [".json", ".yml", ".yaml"];

/** String values in JSON or YAML text: quoted strings, `key: value` scalars and `- item` list entries. */
function* configStrings(text: string): Generator<{ value: string; index: number }> {
	const pattern = /"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'|:[ \t]+([^\s'"#{[][^#\n]*?)[ \t]*$|^[ \t]*-[ \t]+([^\s'"#{[][^#\n]*?)[ \t]*$/gm;
	for (const match of text.matchAll(pattern)) {
		const value = match[1] ?? match[2] ?? match[3] ?? match[4];
		if (value) yield { value, index: match.index + match[0].indexOf(value) };
	}
}

function compareLocations(a: Usage, b: Usage): number {
	return a.location.localeCompare(b.location, undefined, { numeric: true });
}

function flatten(usages: Usage[]): Usage[] {
	return usages.flatMap((u) => [u, ...flatten(u.callers ?? [])]);
}

export class PhpAdapter implements LanguageAdapter {
	readonly language = "php";
	private readonly entries = new Map<string, FileEntry>();
	private projectFiles: string[] = [];
	/** The project's JSON and YAML files outside hidden folders, read for paths to template files. */
	private configFiles: string[] = [];
	private composerFiles: string[] = [];
	private composerFileSet = new Set<string>();
	private scannedFiles = new Set<string>();
	private composer!: ComposerInfo;
	/** Names a vendor scan didn't find, kept until Composer's installed.json changes. */
	private readonly vendorMisses = new Set<string>();
	private installedMtime = -1;
	private byName = new Map<string, PhpDecl[]>();
	/** Aliases the declaration being described uses, in order; reset per describeDecl. */
	private aliasRefs: string[] = [];
	private byMethod = new Map<string, PhpDecl[]>();

	constructor(private readonly config: Config) {}

	accepts(from: string): boolean {
		return /\.php$/i.test(from) || from.includes("\\") || !/[/.]/.test(from);
	}

	/** Re-walk the project and Composer's autoload paths, and re-parse files whose modification time changed. */
	async sync(): Promise<void> {
		this.composer = readComposer(this.config.root);
		const installedMtime = mtimeOf(path.join(this.composer.vendorDir, "composer", "installed.json"));
		if (installedMtime !== this.installedMtime) this.vendorMisses.clear();
		this.installedMtime = installedMtime;
		const vendorName = path.relative(this.config.root, this.composer.vendorDir);
		const skipDirs = vendorName && !vendorName.includes(path.sep) && !vendorName.startsWith("..") ? [vendorName] : ["vendor"];
		const found = walk(this.config.root, { extensions: [".php", ...CONFIG_EXTENSIONS], exclude: this.config.exclude, skipDirs });
		const isPhp = (file: string) => path.extname(file).toLowerCase() === ".php";
		this.projectFiles = [...found.filter(isPhp), ...this.config.include.flatMap((dir) => walk(dir, { extensions: [".php"], exclude: [] }))];
		// Hidden folders (.github, .vscode, tool state) hold records that mention paths, not config the project loads.
		this.configFiles = found.filter((file) => !isPhp(file) && !relativeTo(this.config.root, file).split("/").some((part) => part.startsWith(".")));
		this.composerFiles = this.composer.autoloadPaths.flatMap((p) => walk(p, { extensions: [".php"], exclude: [], gitignore: false, sizeLimit: false }));
		this.composerFileSet = new Set(this.composerFiles);
		const wanted = new Set([...this.projectFiles, ...this.composerFiles, ...this.scannedFiles]);
		let changed = false;
		for (const file of [...this.entries.keys()]) if (!wanted.has(file)) changed = this.entries.delete(file);

		const parser = await getParser();
		for (const file of wanted) changed = this.indexFile(parser, file) || changed;
		if (changed) this.rebuildNames();
	}

	/** Returns whether the file's declarations changed (re-parsed or removed). */
	private indexFile(parser: Parser, file: string): boolean {
		const mtime = mtimeOf(file);
		const existing = this.entries.get(file);
		if (existing && existing.mtime === mtime) return false;
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			return this.entries.delete(file);
		}
		const tree = parser.parse(text);
		if (!tree) return false;
		const extractor = new Extractor(file);
		extractor.run(tree.rootNode);
		tree.delete();
		this.entries.set(file, { mtime, decls: extractor.decls });
		return true;
	}

	private rebuildNames(): void {
		this.byName.clear();
		this.byMethod.clear();
		const add = (map: Map<string, PhpDecl[]>, key: string, decl: PhpDecl) => {
			const list = map.get(key.toLowerCase());
			if (list) list.push(decl);
			else map.set(key.toLowerCase(), [decl]);
		};
		for (const entry of this.entries.values()) {
			for (const decl of entry.decls) {
				add(this.byName, decl.name, decl);
				if (decl.fqn !== decl.name) add(this.byName, decl.fqn, decl);
				for (const member of decl.members) add(this.byMethod, member.name.replace(/^\$/, ""), member);
			}
		}
	}

	private isProject(file: string): boolean {
		return !this.composerFileSet.has(file) && !this.scannedFiles.has(file);
	}

	/** Parse vendor files that declare the name, for packages Composer doesn't autoload (stubs, for one). */
	private async scanVendor(name: string): Promise<boolean> {
		return this.scanVendorWith(await getParser(), name);
	}

	private scanVendorWith(parser: Parser, name: string): boolean {
		const short = name.split(/::|\\/).filter(Boolean).pop()!;
		if (this.vendorMisses.has(short.toLowerCase()) || !fs.existsSync(this.composer.vendorDir)) return false;
		const pattern = new RegExp(`(function\\s+&?${escapeRegExp(short)}\\s*\\(|(class|interface|trait|enum)\\s+${escapeRegExp(short)}\\b)`, "i");
		const files = walk(this.composer.vendorDir, { extensions: [".php"], exclude: [], gitignore: false, sizeLimit: false });
		let added = false;
		for (const file of files) {
			if (this.entries.has(file)) continue;
			let text: string;
			try {
				text = fs.readFileSync(file, "utf8");
			} catch {
				continue;
			}
			if (!pattern.test(text)) continue;
			this.scannedFiles.add(file);
			this.indexFile(parser, file);
			added = true;
		}
		if (added) this.rebuildNames();
		else this.vendorMisses.add(short.toLowerCase());
		return added;
	}

	private lookup(name: string, from: string | undefined): PhpDecl[] {
		const clean = name.replace(/^\\/, "").replace(/->/g, "::");
		let matches: PhpDecl[];
		const memberMatch = /^(.+?)::\$?([A-Za-z_][A-Za-z0-9_]*)$/.exec(clean);
		if (memberMatch) {
			const owners = (this.byName.get(memberMatch[1].toLowerCase()) ?? []).filter((d) => d.members.length);
			matches = owners.flatMap((owner) => owner.members.filter((m) => m.name.replace(/^\$/, "").toLowerCase() === memberMatch[2].toLowerCase()));
		} else {
			matches = this.byName.get(clean.toLowerCase()) ?? [];
			if (!matches.length) matches = this.byMethod.get(clean.toLowerCase()) ?? [];
		}
		if (from) {
			const fromPath = path.resolve(this.config.root, from);
			if (/\.php$/i.test(from)) matches = matches.filter((d) => d.file === fromPath);
			else {
				const ns = from.replace(/^\\|\\$/g, "").toLowerCase();
				matches = matches.filter((d) => d.namespace.toLowerCase() === ns || d.namespace.toLowerCase().startsWith(`${ns}\\`));
			}
		}
		// Project declarations first.
		return [...new Set(matches)].sort((a, b) => Number(this.isProject(b.file)) - Number(this.isProject(a.file)));
	}

	private loc(decl: PhpDecl): string {
		return `${relativeTo(this.config.root, decl.file)}:${decl.line}`;
	}

	// ----------------------------------------------------- type resolution

	private findClass(fqn: string): PhpDecl | undefined {
		const key = fqn.replace(/^\\/, "").toLowerCase();
		// byName also files classes under their short name, so `Card` would find `Fixture\Card` without the full-name check.
		return this.byName.get(key)?.find((d) => ["class", "interface", "trait", "enum"].includes(d.kind) && d.fqn.toLowerCase() === key);
	}

	private resolveClassName(decl: PhpDecl, name: string): string {
		if (name.startsWith("\\")) return name.slice(1);
		const [first, ...rest] = name.split("\\");
		const used = decl.uses[first.toLowerCase()];
		if (used) return [used, ...rest].join("\\");
		return decl.namespace ? `${decl.namespace}\\${name}` : name;
	}

	/** Type aliases visible from a declaration: @phpstan-type / @psalm-type on its class (or itself), plus imported ones. */
	private aliasesFor(decl: PhpDecl, notes: string[], seen = new Set<string>()): Map<string, TypeNode> {
		const holder = decl.owner ?? decl;
		const key = holder.fqn;
		const aliases = new Map<string, TypeNode>();
		if (seen.has(key)) return aliases;
		seen.add(key);
		const sources = [holder, ...(decl !== holder ? [decl] : [])];
		for (const source of sources) {
			const doc = parseDocblock(source.doc);
			for (const tag of doc.tags) {
				if (/^(phpstan|psalm)-type$/.test(tag.name)) {
					const alias = parseAliasTag(tag.body);
					if (alias) aliases.set(alias.name, parseType(alias.type));
				} else if (/^(phpstan|psalm)-import-type$/.test(tag.name)) {
					const imported = parseImportTag(tag.body);
					if (!imported) continue;
					const fqn = this.resolveClassName(source, imported.from);
					const target = this.findClass(fqn);
					if (!target) {
						notes.push(`The type ${imported.name} is imported from ${fqn}, which isn't indexed${this.composer.installed ? "" : " (Composer packages aren't installed)"}, so it isn't expanded.`);
						continue;
					}
					const targetAliases = this.aliasesFor(target, notes, seen);
					const node = targetAliases.get(imported.name);
					if (node) aliases.set(imported.as ?? imported.name, node);
					else notes.push(`${fqn} doesn't declare the type ${imported.name}.`);
				}
			}
		}
		return aliases;
	}

	/**
	 * Parse a PHPDoc type and keep alias names as written. Aliases it uses
	 * (`LinkData`) are recorded so the answer defines them once in `types:`.
	 */
	private resolveType(text: string | undefined, aliases: Map<string, TypeNode>): { text?: string; node?: TypeNode } {
		if (!text) return {};
		const node = parseType(text);
		for (const name of typeNames(node)) {
			if (aliases.has(name) && !this.aliasRefs.includes(name)) this.aliasRefs.push(name);
		}
		return { text: truncate(renderType(node), 600), node };
	}

	/** Keys of an inline array shape. A named alias isn't inline; it goes in `types:`. */
	private shapeFields(node: TypeNode | undefined, depth: number): Field[] | undefined {
		const shape = node && shapeOf(node);
		if (!shape || depth <= 0) return undefined;
		return shape.items.map((item, index) => {
			const field: Field = { name: item.key ?? String(index), type: renderType(item.type), optional: item.optional || undefined };
			const nested = this.shapeFields(item.type, depth);
			if (nested) field.fields = nested;
			return field;
		});
	}

	/** Keys described with hash notation have no type name, so they're always listed in place. */
	private hashFields(fields: HashField[], aliases: Map<string, TypeNode>, depth: number): Field[] {
		return fields.map((hash) => {
			const resolved = this.resolveType(hash.type, aliases);
			const field: Field = { name: hash.name, type: resolved.text, doc: hash.doc, default: hash.default };
			const nested = hash.fields?.length ? this.hashFields(hash.fields, aliases, depth) : this.shapeFields(resolved.node, depth);
			if (nested) field.fields = nested;
			return field;
		});
	}

	/** Define each alias the answer used, then the aliases those use, down to `depth` hops. */
	private aliasTypes(aliases: Map<string, TypeNode>, depth: number): { types: TypeEntry[]; omitted: string[] } {
		const types: TypeEntry[] = [];
		const omitted: string[] = [];
		const queue = this.aliasRefs.map((name) => ({ name, level: 1 }));
		const seen = new Set(this.aliasRefs);
		while (queue.length) {
			const { name, level } = queue.shift()!;
			const node = aliases.get(name);
			if (!node) continue;
			if (level > depth) {
				omitted.push(name);
				continue;
			}
			types.push({ name, definition: truncate(renderType(node), 2000), level });
			for (const inner of typeNames(node)) {
				if (aliases.has(inner) && !seen.has(inner)) {
					seen.add(inner);
					queue.push({ name: inner, level: level + 1 });
				}
			}
		}
		return { types, omitted };
	}

	private paramField(param: PhpParam | undefined, tag: ParamTag | undefined, aliases: Map<string, TypeNode>, defaults: Record<string, string> | undefined, depth: number): Field {
		const name = param?.name ?? tag?.name ?? "";
		const docType = this.resolveType(tag?.type, aliases);
		const field: Field = {
			name: `${param?.byRef || tag?.byRef ? "&" : ""}${param?.variadic || tag?.variadic ? "..." : ""}${name}`,
			type: docType.text ?? param?.type,
			optional: param ? param.default !== undefined || param.variadic || undefined : undefined,
			default: param?.default,
			doc: tag?.doc,
		};
		if (depth > 0) {
			if (tag?.fields?.length) field.fields = this.hashFields(tag.fields, aliases, depth);
			else field.fields = this.shapeFields(docType.node, depth);
		}
		if (depth > 0 && defaults && Object.keys(defaults).length) {
			if (!field.fields) {
				field.fields = Object.entries(defaults).map(([key, value]) => ({ name: key, default: value, optional: true }));
			} else {
				// The code's default wins over a "Default …" phrase in the docblock.
				for (const sub of field.fields) {
					if (defaults[sub.name] !== undefined) sub.default = defaults[sub.name];
				}
				for (const [key, value] of Object.entries(defaults)) {
					if (!field.fields.some((f) => f.name === key)) field.fields.push({ name: key, default: value, optional: true, doc: "Read in the code but not documented." });
				}
			}
		}
		if (field.fields && !field.fields.length) delete field.fields;
		return field;
	}

	private paramTags(doc: Docblock): Map<string, ParamTag> {
		const tags = new Map<string, ParamTag>();
		// Plain @param first, so @phpstan-param / @psalm-param types override it.
		const ordered = [...doc.tags.filter((t) => t.name === "param"), ...doc.tags.filter((t) => /^(phpstan|psalm)-param$/.test(t.name))];
		for (const tag of ordered) {
			const parsed = parseParamBody(tag.body);
			if (!parsed?.name) continue;
			const existing = tags.get(parsed.name);
			tags.set(parsed.name, existing ? { ...existing, type: parsed.type ?? existing.type, fields: existing.fields ?? parsed.fields } : parsed);
		}
		return tags;
	}

	private signatureOf(decl: PhpDecl, doc: Docblock, aliases: Map<string, TypeNode>, depth: number): Signature {
		const tags = this.paramTags(doc);
		const params = decl.params.map((param) => this.paramField(param, tags.get(param.name), aliases, decl.bodyDefaults[param.name], depth));
		const returnTag =
			doc.tags.find((t) => /^(phpstan|psalm)-return$/.test(t.name)) ?? doc.tags.find((t) => t.name === "return" || t.name === "returns");
		let returns: Signature["returns"];
		if (returnTag) {
			const read = parseParamBody(returnTag.body);
			const resolved = this.resolveType(read?.type, aliases);
			returns = { type: resolved.text ?? decl.returnType, doc: read?.doc };
		} else if (decl.returnType) {
			returns = { type: decl.returnType };
		}
		return { text: decl.signature, params, returns };
	}

	private memberSummary(member: PhpDecl): MemberSummary {
		const doc = parseDocblock(member.doc);
		return {
			name: member.kind === "method" && member.modifiers.includes("static") ? `static ${member.name}` : member.name,
			kind: member.kind,
			signature: member.signature,
			summary: doc.summary ? firstLine(doc.summary) : undefined,
			location: this.loc(member),
		};
	}

	private describeDecl(decl: PhpDecl, depth: number): SymbolInfo {
		const notes: string[] = [];
		const doc = parseDocblock(decl.doc);
		const aliases = this.aliasesFor(decl, notes);
		this.aliasRefs = [];
		const info: SymbolInfo = {
			name: decl.name,
			qualifiedName: decl.fqn !== decl.name ? decl.fqn : undefined,
			kind: decl.kind === "file" ? "template file" : decl.kind,
			language: "php",
			location: this.loc(decl),
			dependency: !this.isProject(decl.file) || undefined,
			doc: [doc.summary, doc.description].filter(Boolean).join("\n\n") || undefined,
			resolution: { engine: ENGINE, status: "full", notes, info: [] },
		};
		const skipped = new Set(["param", "return", "returns", "var", "type", "phpstan-param", "psalm-param", "phpstan-return", "psalm-return", "phpstan-type", "psalm-type", "phpstan-import-type", "psalm-import-type"]);
		const tags = doc.tags.filter((t) => !skipped.has(t.name)).map((t) => ({ name: t.name, text: t.body }));
		if (tags.length) info.tags = tags;

		switch (decl.kind) {
			case "function":
			case "method":
				info.signatures = [this.signatureOf(decl, doc, aliases, depth)];
				break;
			case "class":
			case "interface":
			case "trait":
			case "enum": {
				const ctor = decl.members.find((m) => m.kind === "method" && m.name.toLowerCase() === "__construct");
				if (ctor) {
					const ctorDoc = parseDocblock(ctor.doc);
					info.signatures = [{ ...this.signatureOf(ctor, ctorDoc, this.aliasesFor(ctor, notes), depth), text: `${decl.signature}\nnew ${decl.name}${ctor.signature.slice(ctor.signature.indexOf("("))}` }];
				} else {
					info.signatures = [{ text: decl.signature, params: [] }];
				}
				info.members = decl.members.filter((m) => !m.modifiers.includes("private") && !m.modifiers.includes("protected")).map((m) => this.memberSummary(m));
				// The aliases a class declares or imports are part of what it offers, so they're all defined.
				for (const name of aliases.keys()) if (!this.aliasRefs.includes(name)) this.aliasRefs.push(name);
				if (decl.extends.length) {
					const missing = decl.extends.filter((e) => !this.findClass(e));
					if (missing.length) notes.push(`Parent ${missing.join(", ")} isn't indexed, so inherited members aren't listed.`);
					else notes.push(`Inherited members aren't listed. Describe ${decl.extends.join(", ")} for those.`);
				}
				break;
			}
			case "property":
			case "constant":
			case "case": {
				const varTag = doc.tags.find((t) => t.name === "var");
				const parsed = varTag ? parseParamBody(varTag.body) : null;
				const resolved = this.resolveType(parsed?.type, aliases);
				info.type = resolved.text ?? decl.type;
				info.signatures = [{ text: decl.signature, params: [] }];
				if (decl.value !== undefined) info.tags = [...(info.tags ?? []), { name: "value", text: truncate(squash(decl.value), 300) }];
				const fields = this.shapeFields(resolved.node, depth);
				if (fields) info.fields = fields;
				break;
			}
			case "file": {
				const params: Field[] = [];
				for (const tag of doc.tags) {
					if (tag.name !== "var" && tag.name !== "param") continue;
					const parsed = parseParamBody(tag.body);
					if (!parsed?.name) continue;
					params.push(this.paramField(undefined, parsed, aliases, decl.bodyDefaults[parsed.name], depth));
				}
				for (const [variable, defaults] of Object.entries(decl.bodyDefaults)) {
					if (depth <= 0 || params.some((p) => p.name === variable)) continue;
					params.push({ name: variable, fields: Object.entries(defaults).map(([key, value]) => ({ name: key, default: value, optional: true })), doc: "Keys read in the file, not documented." });
				}
				info.signatures = [{ text: `${relativeTo(this.config.root, decl.file)} (reads variables passed to it)`, params }];
				break;
			}
		}
		if (depth > 0) {
			const { types, omitted } = this.aliasTypes(aliases, depth);
			if (types.length) info.types = types;
			if (omitted.length) info.typesOmitted = omitted;
		}
		info.resolution.notes = [...new Set(notes)];
		if (notes.length) info.resolution.status = notes.some((n) => /isn't indexed|doesn't declare|aren't installed/.test(n)) ? "partial" : "full";
		return info;
	}

	async describe(name: string, options: DescribeOptions): Promise<SymbolInfo[]> {
		let matches = this.lookup(name, options.from);
		let scanned = false;
		if (!matches.length && !options.from) {
			scanned = await this.scanVendor(name);
			if (scanned) matches = this.lookup(name, options.from);
		}
		const out = matches.slice(0, MAX_MATCHES).map((decl) => this.describeDecl(decl, options.depth));
		for (const info of out) {
			if (scanned) info.resolution.info!.push("Found by scanning vendor/ (the package isn't in Composer's autoload).");
			info.resolution.info!.push(...this.composer.notes);
		}
		if (matches.length > MAX_MATCHES) out[0]?.resolution.notes.push(`Showing ${MAX_MATCHES} of ${matches.length} matches. Use "Class::method" or the from option to narrow it.`);
		return out;
	}

	async declarations(name: string): Promise<DeclarationRef[]> {
		return this.lookup(name, undefined)
			.slice(0, MAX_MATCHES)
			.map((d) => ({ name: d.fqn, kind: d.kind === "file" ? "template file" : d.kind, language: "php", location: this.loc(d) }));
	}

	async exports(target: string): Promise<ExportsResult | null> {
		const isFile = /\.php$/i.test(target);
		const isNamespace = target.includes("\\");
		if (!isFile && !isNamespace) return null;
		const resolution: Resolution = { engine: ENGINE, status: "full", notes: [], info: [...this.composer.notes] };
		let decls: PhpDecl[] = [];
		let location: string | undefined;
		if (isFile) {
			const file = path.resolve(this.config.root, target);
			if (!this.entries.has(file) && fs.existsSync(file)) {
				this.scannedFiles.add(file);
				this.indexFile(await getParser(), file);
				this.rebuildNames();
			}
			decls = this.entries.get(file)?.decls ?? [];
			location = relativeTo(this.config.root, file);
			if (!fs.existsSync(file)) resolution.notes.push(`${target} doesn't exist.`);
		} else {
			const ns = target.replace(/^\\|\\$/g, "").toLowerCase();
			for (const entry of this.entries.values()) {
				decls.push(...entry.decls.filter((d) => d.namespace.toLowerCase() === ns || d.namespace.toLowerCase().startsWith(`${ns}\\`)));
			}
		}
		const exports = decls.map((d) => ({ ...this.memberSummary(d), name: d.fqn, kind: d.kind === "file" ? "template file" : d.kind }));
		if (!exports.length) resolution.status = "partial";
		return { target, language: "php", location, exports, resolution };
	}

	// ------------------------------------------------------------ usages

	private usagePattern(decl: PhpDecl): RegExp {
		const name = escapeRegExp(decl.name.replace(/^\$/, ""));
		return decl.kind === "file" ? new RegExp(`['"][^'"\\n]*\\b${name}(\\.php)?['"]`, "g") : new RegExp(`\\b${name}\\b`, "g");
	}

	private functionDecl(fqn: string): PhpDecl | undefined {
		const key = fqn.toLowerCase();
		return this.byName.get(key)?.find((d) => d.kind === "function" && d.fqn.toLowerCase() === key);
	}

	/** PHP's rule for a function name: `use function` imports, then the current namespace if it declares the function, then the global one. */
	private resolveFunctionIn(scope: NameScope, name: string): string {
		if (name.startsWith("\\")) return name.slice(1);
		if (name.includes("\\")) return resolveClassIn(scope, name);
		const imported = scope.functions.get(name.toLowerCase());
		if (imported) return imported;
		const local = scope.namespace ? `${scope.namespace}\\${name}` : name;
		return this.functionDecl(local) ? local : name;
	}

	/** The class and everything it extends, implements or uses as a trait, lowercase. */
	private lineage(fqn: string): Set<string> {
		const out = new Set<string>();
		const queue = [fqn];
		while (queue.length) {
			const name = queue.shift()!.toLowerCase();
			if (out.has(name)) continue;
			out.add(name);
			const decl = this.findClass(name);
			if (decl) queue.push(...decl.extends, ...decl.implements, ...(decl.traits ?? []));
		}
		return out;
	}

	/**
	 * Whether a member reached through one of `classes` can be the member
	 * declared in `owner`: the same class, a class that inherits it, or a
	 * parent or interface whose method `owner` implements or overrides.
	 */
	private related(classes: string[], owner: string): boolean {
		const target = owner.toLowerCase();
		const ownerLineage = this.lineage(owner);
		return classes.some((c) => ownerLineage.has(c.toLowerCase()) || this.lineage(c).has(target));
	}

	private memberIn(classFqn: string, name: string, kind: "method" | "property", seen = new Set<string>()): PhpDecl | undefined {
		const key = classFqn.toLowerCase();
		if (seen.has(key)) return undefined;
		seen.add(key);
		const decl = this.findClass(classFqn);
		if (!decl) return undefined;
		const own = decl.members.find((m) => m.kind === kind && (kind === "method" ? m.name.toLowerCase() === name.toLowerCase() : m.name === `$${name}`));
		if (own) return own;
		for (const parent of [...(decl.traits ?? []), ...decl.extends, ...decl.implements]) {
			const found = this.memberIn(parent, name, kind, seen);
			if (found) return found;
		}
		return undefined;
	}

	/** Classes a function or method returns, or a property holds, from its native type or PHPDoc. */
	private declaredClasses(decl: PhpDecl, self: string | undefined): string[] | null {
		const doc = parseDocblock(decl.doc);
		const tag =
			decl.kind === "property"
				? doc.tags.find((t) => t.name === "var")
				: doc.tags.find((t) => /^(phpstan|psalm)-return$/.test(t.name)) ?? doc.tags.find((t) => t.name === "return");
		const text = (tag && parseParamBody(tag.body)?.type) ?? (decl.kind === "property" ? decl.type : decl.returnType);
		return classesOfType(text, (n) => this.resolveClassName(decl, n), self);
	}

	private memberClasses(owners: string[], name: string, kind: "method" | "property"): string[] | null {
		const out: string[] = [];
		for (const owner of owners) {
			const member = this.memberIn(owner, name, kind);
			const classes = member && this.declaredClasses(member, owner);
			if (!classes) return null;
			out.push(...classes);
		}
		return out.length ? [...new Set(out)] : null;
	}

	private where(parsed: ParsedFile, node: Node): Where {
		const scope = scopeAt(parsed.scopes, node.startIndex);
		for (let current = node.parent; current; current = current.parent) {
			if (!CLASS_LIKE.has(current.type)) continue;
			const name = current.childForFieldName("name")?.text;
			return { parsed, scope, self: name ? (scope.namespace ? `${scope.namespace}\\${name}` : name) : undefined };
		}
		return { parsed, scope };
	}

	/** Classes named before `::`: `self`, `static`, `parent`, a class name, or an expression. */
	private scopeClasses(scope: Node | null, where: Where, depth: number): string[] | null {
		if (!scope) return null;
		if (scope.type === "relative_scope") {
			if (!where.self) return null;
			if (scope.text.toLowerCase() !== "parent") return [where.self];
			const parent = this.findClass(where.self)?.extends[0];
			return parent ? [parent] : null;
		}
		if (scope.type === "name" || scope.type === "qualified_name") return [resolveClassIn(where.scope, scope.text)];
		return this.inferType(scope, where, depth + 1);
	}

	/**
	 * The classes an expression's value can be, or null when that can't be
	 * worked out from the code: `$this`, `new X`, typed parameters and
	 * properties, `@var` and `@param` tags, return types of known functions
	 * and methods, and variables assigned from any of those.
	 */
	private inferType(node: Node | null, where: Where, depth = 0): string[] | null {
		if (!node || depth > 6) return null;
		switch (node.type) {
			case "parenthesized_expression":
			case "clone_expression":
				return this.inferType(node.namedChildren[0], where, depth + 1);
			case "variable_name":
				return node.text === "$this" ? (where.self ? [where.self] : null) : this.variableType(node, where, depth);
			case "object_creation_expression": {
				const cls = node.namedChildren[0];
				if (cls?.type !== "name" && cls?.type !== "qualified_name") return null;
				if (/^(self|static)$/i.test(cls.text)) return where.self ? [where.self] : null;
				return [resolveClassIn(where.scope, cls.text)];
			}
			case "member_access_expression":
			case "nullsafe_member_access_expression":
			case "member_call_expression":
			case "nullsafe_member_call_expression": {
				const owners = this.inferType(node.childForFieldName("object"), where, depth + 1);
				const name = node.childForFieldName("name");
				if (!owners || name?.type !== "name") return null;
				return this.memberClasses(owners, name.text, node.type.endsWith("call_expression") ? "method" : "property");
			}
			case "scoped_call_expression": {
				const owners = this.scopeClasses(node.childForFieldName("scope"), where, depth);
				const name = node.childForFieldName("name");
				if (!owners || name?.type !== "name") return null;
				return this.memberClasses(owners, name.text, "method");
			}
			case "function_call_expression": {
				const fn = node.childForFieldName("function");
				if (fn?.type !== "name" && fn?.type !== "qualified_name") return null;
				const decl = this.functionDecl(this.resolveFunctionIn(where.scope, fn.text));
				return decl ? this.declaredClasses(decl, undefined) : null;
			}
		}
		return null;
	}

	/** Look for the variable in its function, then in the function around a closure that captures it. */
	private variableType(variable: Node, where: Where, depth: number): string[] | null {
		const name = variable.text;
		let fn = enclosingFunction(variable);
		while (true) {
			const found = this.typeInFunction(fn, name, where, depth);
			if (found !== undefined) return found;
			const captures = fn?.type === "arrow_function" || (fn?.type === "anonymous_function" && closureUses(fn, name));
			if (!fn || !captures) return null;
			fn = enclosingFunction(fn);
		}
	}

	/** Undefined when the function doesn't mention the variable; null when it does but the class isn't known. */
	private typeInFunction(fn: Node | null, name: string, where: Where, depth: number): string[] | null | undefined {
		const resolve = (n: string) => resolveClassIn(where.scope, n);
		const own = (node: Node) => enclosingFunction(node)?.id === fn?.id;
		if (fn) {
			for (const param of fn.childForFieldName("parameters")?.namedChildren ?? []) {
				if (param?.childForFieldName("name")?.text !== name) continue;
				const declared = classesOfType(param.childForFieldName("type")?.text, resolve, where.self);
				if (declared) return declared;
				return classesOfType(this.paramTags(parseDocblock(docFor(fn))).get(name)?.type, resolve, where.self);
			}
		}
		const body = fn ? fn.childForFieldName("body") ?? fn : where.parsed.tree.rootNode;
		for (const comment of body.descendantsOfType("comment")) {
			if (!comment.text.includes("@var") || !own(comment)) continue;
			for (const tag of parseDocblock(comment.text).tags) {
				if (!/^((phpstan|psalm)-)?var$/.test(tag.name)) continue;
				const parsed = parseParamBody(tag.body);
				const target = parsed?.name ?? assignedVariable(comment.nextNamedSibling);
				if (target === name) return classesOfType(parsed?.type, resolve, where.self);
			}
		}
		let mentioned = false;
		const out: string[] = [];
		for (const node of body.descendantsOfType(["assignment_expression", "catch_clause", "foreach_statement", "global_declaration"])) {
			if (!own(node)) continue;
			let classes: string[] | null;
			if (node.type === "assignment_expression") {
				if (node.childForFieldName("left")?.text !== name) continue;
				classes = this.inferType(node.childForFieldName("right"), where, depth + 1);
			} else if (node.type === "catch_clause") {
				if (node.childForFieldName("name")?.text !== name) continue;
				classes = classesOfType(node.childForFieldName("type")?.text, resolve, where.self);
			} else {
				// A foreach value or `global $x`: its class isn't known from here.
				const body = node.childForFieldName("body");
				const bound = node.namedChildren.slice(node.type === "foreach_statement" ? 1 : 0).filter((c) => c && c.id !== body?.id);
				if (!bound.some((c) => c!.text === name || c!.descendantsOfType("variable_name").some((v) => v.text === name))) continue;
				classes = null;
			}
			if (!classes) return null;
			mentioned = true;
			out.push(...classes);
		}
		return mentioned ? [...new Set(out)] : undefined;
	}

	/** The classes behind the first item of a callable array: `$this`, `Foo::class`, `'Foo'` or an object. */
	private callableTarget(node: Node, where: Where): string[] | null {
		if (node.type === "class_constant_access_expression" && node.namedChildren[1]?.text.toLowerCase() === "class") {
			return this.scopeClasses(node.namedChildren[0], where, 0);
		}
		if (node.type === "string" || node.type === "encapsed_string") {
			const name = callableName(node, where.scope);
			return name ? [name] : null;
		}
		return this.inferType(node, where);
	}

	/** The function, method or constructor a call runs, looking in vendor/ for functions Composer doesn't autoload (stubs). */
	private calledDecl(call: Node, where: Where, parser: Parser): PhpDecl | undefined {
		const name = call.childForFieldName("name");
		switch (call.type) {
			case "function_call_expression": {
				const fn = call.childForFieldName("function");
				if (fn?.type !== "name" && fn?.type !== "qualified_name") return undefined;
				const fqn = this.resolveFunctionIn(where.scope, fn.text);
				if (!this.functionDecl(fqn) && !fqn.includes("\\")) this.scanVendorWith(parser, fqn);
				return this.functionDecl(fqn);
			}
			case "member_call_expression":
			case "nullsafe_member_call_expression":
			case "scoped_call_expression": {
				const owners = call.type === "scoped_call_expression" ? this.scopeClasses(call.childForFieldName("scope"), where, 0) : this.inferType(call.childForFieldName("object"), where);
				return owners?.length === 1 && name?.type === "name" ? this.memberIn(owners[0], name.text, "method") : undefined;
			}
			case "object_creation_expression": {
				const owners = this.inferType(call, where);
				return owners?.length === 1 ? this.memberIn(owners[0], "__construct", "method") : undefined;
			}
		}
		return undefined;
	}

	/**
	 * Whether the parameter a value is passed to takes a callable, from the
	 * called function's native type or PHPDoc. Undefined when the value isn't
	 * an argument, or the function or the parameter's type isn't known.
	 */
	private receivesCallable(value: Node, where: Where, parser: Parser): boolean | undefined {
		const arg = value.parent?.type === "argument" ? value.parent : null;
		const call = arg?.parent?.parent;
		if (!arg || !call) return undefined;
		const decl = this.calledDecl(call, where, parser);
		if (!decl) return undefined;
		const named = arg.childForFieldName("name")?.text;
		const index = arg.parent!.namedChildren.filter((c) => c?.type === "argument").findIndex((c) => c!.id === arg.id);
		const last = decl.params[decl.params.length - 1];
		const param = named ? decl.params.find((p) => p.name === `$${named}`) : decl.params[index] ?? (last?.variadic ? last : undefined);
		if (!param) return undefined;
		const type = this.paramTags(parseDocblock(decl.doc)).get(param.name)?.type ?? param.type;
		return type ? /\b(callable|closure)\b/i.test(type) : undefined;
	}

	private verdict(classes: string[] | null, owner: string): "yes" | "no" | "unknown" {
		if (!classes) return "unknown";
		return this.related(classes, owner) ? "yes" : "no";
	}

	/** Where a function, class or class member is used, read from the syntax tree. */
	private *astMatches(parsed: ParsedFile, decl: PhpDecl, parser: Parser): Generator<Match> {
		const root = parsed.tree.rootNode;
		const short = decl.name.replace(/^\$/, "");
		const lower = short.toLowerCase();
		const fqn = decl.fqn.toLowerCase();
		const owner = decl.owner?.fqn;
		switch (decl.kind) {
			case "function":
				for (const call of root.descendantsOfType("function_call_expression")) {
					const fn = call.childForFieldName("function");
					if (!fn || (fn.type !== "name" && fn.type !== "qualified_name") || lastSegment(fn.text).toLowerCase() !== lower) continue;
					if (this.resolveFunctionIn(this.where(parsed, fn).scope, fn.text).toLowerCase() === fqn) yield { node: fn };
				}
				// A string naming the function is a callback only where a callable is expected; hook names often match function names.
				for (const str of root.descendantsOfType(["string", "encapsed_string"])) {
					if (!str.text.toLowerCase().includes(lower) || insideCallTo(str, EXISTENCE_CHECKS)) continue;
					const where = this.where(parsed, str);
					if (callableName(str, where.scope)?.toLowerCase() !== fqn) continue;
					const value = str.parent?.type === "binary_expression" ? str.parent : str;
					const receives = this.receivesCallable(value, where, parser);
					if (receives !== false) yield { node: str, callback: true, unconfirmed: receives === undefined };
				}
				return;
			case "class":
			case "interface":
			case "trait":
			case "enum":
				for (const node of root.descendantsOfType(["name", "qualified_name"])) {
					if (lastSegment(node.text).toLowerCase() !== lower || !isClassReference(node)) continue;
					if (resolveClassIn(this.where(parsed, node).scope, node.text).toLowerCase() === fqn) yield { node };
				}
				return;
			case "method":
				if (!owner) return;
				for (const call of root.descendantsOfType(["member_call_expression", "nullsafe_member_call_expression", "scoped_call_expression"])) {
					const name = call.childForFieldName("name");
					if (name?.type !== "name" || name.text.toLowerCase() !== lower) continue;
					const where = this.where(parsed, call);
					const classes = call.type === "scoped_call_expression" ? this.scopeClasses(call.childForFieldName("scope"), where, 0) : this.inferType(call.childForFieldName("object"), where);
					const verdict = this.verdict(classes, owner);
					if (verdict !== "no") yield { node: name, unconfirmed: verdict === "unknown" };
				}
				for (const array of root.descendantsOfType("array_creation_expression")) {
					const items = array.namedChildren.filter((c) => c?.type === "array_element_initializer");
					if (items.length !== 2 || items.some((item) => item!.namedChildCount !== 1)) continue;
					const [target, method] = items.map((item) => item!.namedChildren[0]!);
					if ((method.type !== "string" && method.type !== "encapsed_string") || callableName(method, emptyScope())?.toLowerCase() !== lower) continue;
					const where = this.where(parsed, array);
					const verdict = this.verdict(this.callableTarget(target, where), owner);
					// The [object, 'method'] shape is a callable on its own; only a parameter typed as something else rules it out.
					if (verdict !== "no" && this.receivesCallable(array, where, parser) !== false) yield { node: method, callback: true, unconfirmed: verdict === "unknown" };
				}
				for (const str of root.descendantsOfType(["string", "encapsed_string"])) {
					const where = str.text.includes("::") ? this.where(parsed, str) : undefined;
					const [cls, method] = (where && callableName(str, where.scope)?.split("::")) || [];
					if (!where || !cls || method?.toLowerCase() !== lower) continue;
					const receives = this.receivesCallable(str, where, parser);
					const verdict = this.verdict([cls], owner);
					if (verdict !== "no" && receives !== false) yield { node: str, callback: true, unconfirmed: verdict === "unknown" || receives === undefined };
				}
				return;
			case "property":
				if (!owner) return;
				for (const access of root.descendantsOfType(["member_access_expression", "nullsafe_member_access_expression", "scoped_property_access_expression"])) {
					const name = access.childForFieldName("name");
					if (!name || (name.type === "variable_name" ? name.text.slice(1) : name.text) !== short) continue;
					const where = this.where(parsed, access);
					const classes =
						access.type === "scoped_property_access_expression" ? this.scopeClasses(access.childForFieldName("scope"), where, 0) : this.inferType(access.childForFieldName("object"), where);
					const verdict = this.verdict(classes, owner);
					if (verdict !== "no") yield { node: name, unconfirmed: verdict === "unknown" };
				}
				return;
			case "constant":
			case "case":
				if (!owner) return;
				for (const access of root.descendantsOfType("class_constant_access_expression")) {
					const [scope, name] = access.namedChildren;
					if (name?.text !== short) continue;
					const verdict = this.verdict(this.scopeClasses(scope, this.where(parsed, access), 0), owner);
					if (verdict !== "no") yield { node: name, unconfirmed: verdict === "unknown" };
				}
				return;
		}
	}

	/** Template files and global constants are found by name in the text, as strings and bare words. */
	private *textMatches(parsed: ParsedFile, decl: PhpDecl): Generator<Match> {
		const pattern = this.usagePattern(decl);
		const { text } = parsed;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text))) {
			const offset = match.index + match[0].search(/[\w'"]/);
			const node = parsed.tree.rootNode.descendantForIndex(offset);
			if (!node || node.type === "comment" || node.parent?.type === "comment") continue;
			if (decl.kind !== "file" && (node.type === "string_content" || node.parent?.type === "string")) continue;
			if (parsed.file === decl.file && lineOf(node) === decl.line) continue;
			if (/^\s*use\s/.test(text.slice(text.lastIndexOf("\n", match.index) + 1, match.index + 1))) continue;
			yield { node };
		}
	}

	/**
	 * The function, method or template file a usage is in. Closures are
	 * looked through, so a call inside `array_map( fn … )` counts for the
	 * function around it.
	 */
	private callerOf(parsed: ParsedFile, node: Node): { label: string; decl: PhpDecl } | undefined {
		const decls = this.entries.get(parsed.file)?.decls ?? [];
		for (let current = node.parent; current; current = current.parent) {
			if (current.type === "function_definition") {
				const line = lineOf(current);
				const decl = decls.find((d) => d.kind === "function" && d.line === line);
				return decl && { label: decl.name, decl };
			}
			if (current.type === "method_declaration") {
				const line = lineOf(current);
				for (const owner of decls) {
					const method = owner.members.find((m) => m.kind === "method" && m.line === line);
					if (method) return { label: `${owner.name}::${method.name}`, decl: method };
				}
				return undefined;
			}
		}
		const file = decls.find((d) => d.kind === "file");
		return file && { label: relativeTo(this.config.root, parsed.file), decl: file };
	}

	private usageKey(decl: PhpDecl): string {
		return `${decl.file}:${decl.line}:${decl.fqn}`;
	}

	/**
	 * Paths in the project's JSON and YAML files that resolve to a template
	 * file, such as `"render": "file:./Hero.php"`. A leading `scheme:` is
	 * dropped, and the path is resolved from the config file's folder or the
	 * project root.
	 */
	private configSites(decl: PhpDecl, cache: FileCache): UsageSite<PhpDecl>[] {
		const base = path.basename(decl.file);
		const sites = new Map<string, UsageSite<PhpDecl>>();
		for (const file of this.configFiles) {
			const text = cache.text(file);
			if (text === null || !text.includes(base)) continue;
			for (const { value, index } of configStrings(text)) {
				if (!value.includes(base)) continue;
				const target = value.replace(/\\\//g, "/").replace(/^[a-z][\w+.-]+:(?!\/\/)/i, "");
				if (![path.dirname(file), this.config.root].some((dir) => path.resolve(dir, target) === decl.file)) continue;
				const start = text.lastIndexOf("\n", index - 1) + 1;
				const end = text.indexOf("\n", index);
				const location = `${relativeTo(this.config.root, file)}:${text.slice(0, start).split("\n").length}`;
				sites.set(location, { usage: { location, text: text.slice(start, end === -1 ? undefined : end).trim() } });
			}
		}
		return [...sites.values()];
	}

	/** Usages in the project: its PHP files and, for a template file, its config files. */
	private projectSites(decl: PhpDecl, cache: FileCache): UsageSite<PhpDecl>[] {
		const sites = this.usageSites(decl, this.projectFiles, cache);
		if (decl.kind !== "file") return sites;
		return [...sites, ...this.configSites(decl, cache)].sort((a, b) => Number(!!a.usage.unconfirmed) - Number(!!b.usage.unconfirmed) || compareLocations(a.usage, b.usage));
	}

	/** Usages of one declaration in `files`, the class-confirmed ones first. */
	private usageSites(decl: PhpDecl, files: string[], cache: FileCache): UsageSite<PhpDecl>[] {
		const textual = decl.kind === "file" || (decl.kind === "constant" && !decl.owner);
		const caseless = ["function", "method", "class", "interface", "trait", "enum"].includes(decl.kind);
		const prefilter = new RegExp(escapeRegExp(decl.name.replace(/^\$/, "")), caseless ? "i" : "");
		const ranked = new Map<string, { site: UsageSite<PhpDecl>; rank: number }>();
		for (const file of files) {
			const text = cache.text(file);
			if (text === null || !prefilter.test(text)) continue;
			const parsed = cache.parse(file);
			if (!parsed) continue;
			for (const match of textual ? this.textMatches(parsed, decl) : this.astMatches(parsed, decl, cache.parser)) {
				const location = `${relativeTo(this.config.root, file)}:${lineOf(match.node)}`;
				const rank = match.unconfirmed ? 1 : 0;
				const existing = ranked.get(location);
				if (existing && existing.rank <= rank) continue;
				const usage: Usage = { location, text: trimBlock(this.contextNode(match.node).text) };
				if (match.callback) usage.callback = true;
				if (match.unconfirmed) usage.unconfirmed = true;
				const caller = this.callerOf(parsed, match.node);
				if (caller) usage.in = { name: caller.label, kind: caller.decl.kind === "file" ? "template file" : caller.decl.kind };
				const followed = caller && !match.callback && !match.unconfirmed;
				ranked.set(location, { site: followed ? { usage, caller: { key: this.usageKey(caller.decl), handle: caller.decl } } : { usage }, rank });
			}
		}
		return [...ranked.values()].sort((a, b) => a.rank - b.rank || compareLocations(a.site.usage, b.site.usage)).map((r) => r.site);
	}

	private contextNode(node: Node): Node {
		let current: Node | null = node;
		for (let i = 0; current && i < 10; i++, current = current.parent) {
			if (
				[
					"function_call_expression",
					"member_call_expression",
					"nullsafe_member_call_expression",
					"scoped_call_expression",
					"object_creation_expression",
					"class_constant_access_expression",
				].includes(current.type)
			) {
				return current;
			}
			if (/_statement$/.test(current.type) || current.type === "simple_parameter" || current.type === "base_clause") return current;
		}
		return node;
	}

	async usages(name: string, options: UsagesOptions): Promise<UsagesResult | null> {
		if (options.from && !this.accepts(options.from)) return null;
		let targets = this.lookup(name, options.from);
		if (!targets.length && !options.from && (await this.scanVendor(name))) targets = this.lookup(name, undefined);
		const resolution: Resolution = { engine: ENGINE, status: "full", notes: [], info: [...this.composer.notes] };
		if (!targets.length) return { query: name, language: "php", total: 0, usages: [], resolution };

		const cache = new FileCache(await getParser());
		try {
			const search = (sitesOf: (decl: PhpDecl) => UsageSite<PhpDecl>[]) => {
				const byLocation = new Map<string, UsageSite<PhpDecl>>();
				for (const decl of targets) {
					for (const site of sitesOf(decl)) {
						const existing = byLocation.get(site.usage.location);
						if (!existing || (existing.usage.unconfirmed && !site.usage.unconfirmed)) byLocation.set(site.usage.location, site);
					}
				}
				return [...byLocation.values()].sort((a, b) => Number(!!a.usage.unconfirmed) - Number(!!b.usage.unconfirmed) || compareLocations(a.usage, b.usage));
			};
			let sites = search((decl) => this.projectSites(decl, cache));
			if (!sites.length) {
				const dependencies = [...this.composerFiles, ...this.scannedFiles];
				sites = search((decl) => this.usageSites(decl, dependencies, cache));
				if (sites.length) resolution.notes.push("No usages in the project's own files, so these are from dependencies.");
			}
			const top = sites.slice(0, options.limit);
			const expanded = new Set(targets.map((t) => this.usageKey(t)));
			expandCallers(top, options.depth, options.limit, (decl) => this.projectSites(decl, cache), expanded);

			const all = flatten(top.map((site) => site.usage));
			const followed = options.depth > 1 ? " Their callers aren't followed." : "";
			if (targets.some((t) => t.kind === "file" || (t.kind === "constant" && !t.owner)) && sites.length) {
				resolution.notes.push("In PHP code, template files are found through strings that mention their name and global constants by name, so a different symbol with the same name can show up.");
			}
			if (all.some((u) => u.unconfirmed && !u.callback)) {
				resolution.notes.push(`Usages marked unconfirmed reach a member with this name through a value whose class couldn't be worked out, so they may belong to another class.${followed}`);
			}
			if (all.some((u) => u.callback)) {
				resolution.notes.push(`Usages marked callback pass it by name (a string or an [object, 'method'] array) to code that calls it later, such as a hook or a sort function.${followed}`);
			}
			if (all.some((u) => u.callback && u.unconfirmed)) {
				resolution.notes.push(
					"Callbacks also marked unconfirmed name it in a string where a callable isn't known to be expected: inside an array, or passed to a function that isn't indexed (installing the framework's stubs confirms those). The string may be something else with the same name, such as a hook name.",
				);
			}
			return { query: name, language: "php", total: sites.length, usages: top.map((site) => site.usage), resolution };
		} finally {
			cache.dispose();
		}
	}

	async status(): Promise<AdapterStatus> {
		return {
			language: "php",
			engine: ENGINE,
			files: this.projectFiles.length + this.composerFiles.length,
			notes: [
				`${this.projectFiles.length} project files and ${this.composerFiles.length} files from Composer autoload are indexed. PHP doesn't need to be installed.`,
				...this.composer.notes,
			],
		};
	}
}
