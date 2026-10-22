import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node, type Tree } from "web-tree-sitter";
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
const SETUP_TTL_MS = 2000;
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
			if (member.type === "method_declaration") {
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

const MERGE_FUNCTIONS = new Set(["wp_parse_args", "array_merge", "array_replace", "array_replace_recursive", "shortcode_atts"]);

/**
 * Defaults for array keys, read from code that does
 * `$args['key'] ?? default`, `isset( $args['key'] ) ? $args['key'] : default`,
 * or merges `$args` with a literal array of defaults (array_merge, wp_parse_args).
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

	for (const node of body.descendantsOfType(["binary_expression", "conditional_expression", "function_call_expression"])) {
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
			const fn = node.childForFieldName("function")?.text;
			if (!fn || !MERGE_FUNCTIONS.has(fn)) continue;
			const args = (node.childForFieldName("arguments")?.namedChildren ?? []).map((a) => a?.namedChildren[0] ?? a).filter(Boolean) as Node[];
			const variable = args.find((a) => a.type === "variable_name" && (!vars || vars.has(a.text)) && !arrays.has(a.text));
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

export class PhpAdapter implements LanguageAdapter {
	readonly language = "php";
	private readonly entries = new Map<string, FileEntry>();
	private projectFiles: string[] = [];
	private composerFiles: string[] = [];
	private composerFileSet = new Set<string>();
	private scannedFiles = new Set<string>();
	private composer!: ComposerInfo;
	private setupAt = 0;
	private byName = new Map<string, PhpDecl[]>();
	/** Aliases the declaration being described uses, in order; reset per describeDecl. */
	private aliasRefs: string[] = [];
	private byMethod = new Map<string, PhpDecl[]>();

	constructor(private readonly config: Config) {}

	accepts(from: string): boolean {
		return /\.php$/i.test(from) || from.includes("\\") || !/[/.]/.test(from);
	}

	private async refresh(force = false): Promise<void> {
		if (!force && Date.now() - this.setupAt < SETUP_TTL_MS && this.byName.size) return;
		this.composer = readComposer(this.config.root);
		const vendorName = path.relative(this.config.root, this.composer.vendorDir);
		const skipDirs = vendorName && !vendorName.includes(path.sep) && !vendorName.startsWith("..") ? [vendorName] : ["vendor"];
		this.projectFiles = [
			...walk(this.config.root, { extensions: [".php"], exclude: this.config.exclude, skipDirs }),
			...this.config.include.flatMap((dir) => walk(dir, { extensions: [".php"], exclude: [] })),
		];
		this.composerFiles = this.composer.autoloadPaths.flatMap((p) => walk(p, { extensions: [".php"], exclude: [], gitignore: false, sizeLimit: false }));
		this.composerFileSet = new Set(this.composerFiles);
		const wanted = new Set([...this.projectFiles, ...this.composerFiles, ...this.scannedFiles]);
		for (const file of [...this.entries.keys()]) if (!wanted.has(file)) this.entries.delete(file);

		const parser = await getParser();
		for (const file of wanted) this.indexFile(parser, file);
		this.rebuildNames();
		this.setupAt = Date.now();
	}

	private indexFile(parser: Parser, file: string): void {
		const mtime = mtimeOf(file);
		const existing = this.entries.get(file);
		if (existing && existing.mtime === mtime) return;
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			this.entries.delete(file);
			return;
		}
		const tree = parser.parse(text);
		if (!tree) return;
		const extractor = new Extractor(file);
		extractor.run(tree.rootNode);
		tree.delete();
		this.entries.set(file, { mtime, decls: extractor.decls });
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
		if (!fs.existsSync(this.composer.vendorDir)) return false;
		const short = name.split(/::|\\/).filter(Boolean).pop()!;
		const pattern = new RegExp(`(function\\s+&?${escapeRegExp(short)}\\s*\\(|(class|interface|trait|enum)\\s+${escapeRegExp(short)}\\b)`, "i");
		const files = walk(this.composer.vendorDir, { extensions: [".php"], exclude: [], gitignore: false, sizeLimit: false });
		const parser = await getParser();
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
		const list = this.byName.get(fqn.replace(/^\\/, "").toLowerCase()) ?? [];
		return list.find((d) => ["class", "interface", "trait", "enum"].includes(d.kind));
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
		await this.refresh();
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
		await this.refresh();
		return this.lookup(name, undefined)
			.slice(0, MAX_MATCHES)
			.map((d) => ({ name: d.fqn, kind: d.kind === "file" ? "template file" : d.kind, language: "php", location: this.loc(d) }));
	}

	async exports(target: string): Promise<ExportsResult | null> {
		const isFile = /\.php$/i.test(target);
		const isNamespace = target.includes("\\");
		if (!isFile && !isNamespace) return null;
		await this.refresh();
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
		switch (decl.kind) {
			case "function":
				return new RegExp(`(?<!function\\s+&?)(?<!->|::|\\$)\\b${name}\\s*\\(`, "gi");
			case "method":
				return new RegExp(`(->|::|\\?->)${name}\\s*\\(`, "gi");
			case "property":
				return new RegExp(`(->|::\\$)${name}\\b`, "g");
			case "constant":
			case "case":
				return decl.owner ? new RegExp(`::${name}\\b`, "g") : new RegExp(`\\b${name}\\b`, "g");
			case "file":
				return new RegExp(`['"][^'"\\n]*\\b${name}(\\.php)?['"]`, "g");
			default:
				return new RegExp(`(?<![\\w$>])${name}\\b`, "g");
		}
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
		await this.refresh();
		let targets = this.lookup(name, options.from);
		if (!targets.length && !options.from && (await this.scanVendor(name))) targets = this.lookup(name, undefined);
		const resolution: Resolution = { engine: ENGINE, status: "full", notes: [], info: [...this.composer.notes] };
		if (!targets.length) return { query: name, language: "php", total: 0, usages: [], resolution };

		const parser = await getParser();
		const search = (files: string[]): Usage[] => {
			const found: Usage[] = [];
			const seen = new Set<string>();
			for (const file of files) {
				let text: string;
				try {
					text = fs.readFileSync(file, "utf8");
				} catch {
					continue;
				}
				let tree: Tree | null = null;
				for (const decl of targets) {
					const pattern = this.usagePattern(decl);
					if (!pattern.test(text)) continue;
					pattern.lastIndex = 0;
					tree ??= parser.parse(text);
					if (!tree) break;
					let match: RegExpExecArray | null;
					while ((match = pattern.exec(text))) {
						const offset = match.index + match[0].search(/[\w'"]/);
						const node = tree.rootNode.descendantForIndex(offset);
						if (!node || node.type === "comment" || node.parent?.type === "comment") continue;
						if (decl.kind !== "file" && (node.type === "string_content" || node.parent?.type === "string")) continue;
						const line = text.slice(0, match.index).split("\n").length;
						if (file === decl.file && line === decl.line) continue;
						if (/^\s*use\s/.test(text.slice(text.lastIndexOf("\n", match.index) + 1, match.index + 1))) continue;
						const location = `${relativeTo(this.config.root, file)}:${line}`;
						if (seen.has(location)) continue;
						seen.add(location);
						found.push({ location, text: trimBlock(this.contextNode(node).text) });
					}
				}
				tree?.delete();
			}
			return found;
		};

		let usages = search(this.projectFiles);
		if (!usages.length) {
			usages = search([...this.composerFiles, ...this.scannedFiles]);
			if (usages.length) resolution.notes.push("No usages in the project's own files, so these are from dependencies.");
		}
		usages.sort((a, b) => a.location.localeCompare(b.location, undefined, { numeric: true }));
		resolution.notes.push("Usages are found by name, so a different symbol with the same name can show up.");
		return { query: name, language: "php", total: usages.length, usages: usages.slice(0, options.limit), resolution };
	}

	async status(): Promise<AdapterStatus> {
		await this.refresh(true);
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
