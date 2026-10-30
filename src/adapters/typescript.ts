import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type TS from "typescript";
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

type Ts = typeof TS;

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
/** Above this many props, props inherited from the standard library or @types packages are summarized. */
const MAX_FIELDS = 60;
const MAX_OVERLOADS = 5;
/** Hard stop for the `types:` section; the character budget in the workspace normally ends it much earlier. */
const MAX_TYPE_ENTRIES = 200;
/** Longest alias definition worth printing. */
const MAX_DEFINITION = 800;
/** Packages whose types agents know as well as TypeScript's standard library. */
const KNOWN_TYPE_PACKAGES = /[\\/]node_modules[\\/]@types[\\/](react|react-dom)[\\/]/;

/**
 * Custom types found while describing one symbol, waiting to be defined in
 * its `types:` section. Types are keyed by their declaration, so every use of
 * a generic (`Transform<A>`, `Transform<B>`) is one entry.
 */
class TypeContext {
	readonly queue: { type: TS.Type; level: number }[] = [];
	private readonly keys = new Set<unknown>();
	constructor(readonly anchor: TS.Node) {}
	private key(type: TS.Type): unknown {
		return type.aliasSymbol ?? type.getSymbol() ?? type;
	}
	/** Queue a type once. A type already queued (or the symbol's own type) is skipped. */
	enqueue(type: TS.Type, level: number): void {
		const key = this.key(type);
		if (this.keys.has(key)) return;
		this.keys.add(key);
		this.queue.push({ type, level });
	}
	/** Mark a type as already shown, so it isn't defined again. Anonymous types have no key to share. */
	exclude(type: TS.Type): void {
		this.keys.add(this.key(type));
	}
}
interface LoadedCompiler {
	ts: Ts;
	engine: string;
	notes: string[];
}

/**
 * Prefer the project's TypeScript so results match the project's own
 * type-check. Fall back to the bundled copy when the project has none, or
 * when its package doesn't expose the classic compiler API (TypeScript 7's
 * native port, for one).
 */
function loadCompiler(root: string): LoadedCompiler {
	const notes: string[] = [];
	try {
		const projectRequire = createRequire(path.join(root, "package.json"));
		const resolved = projectRequire.resolve("typescript");
		const loaded = projectRequire("typescript");
		const ts = (loaded.default ?? loaded) as Ts;
		if (typeof ts.createLanguageService === "function") {
			// Node looks in parent folders too (hoisted monorepo installs); say where it came from when that happens.
			const inside = !path.relative(root, resolved).startsWith("..");
			const where = inside ? "project" : `found above the root, in ${path.dirname(path.dirname(path.dirname(resolved)))}`;
			return { ts, engine: `typescript ${ts.version} (${where})`, notes };
		}
		notes.push(
			`The project's TypeScript (${(ts as { version?: string }).version ?? "unknown version"}) doesn't expose the compiler API this server uses, so the bundled TypeScript was used instead.`,
		);
	} catch {
		// No TypeScript reachable from the project root.
	}
	const ts = createRequire(import.meta.url)("typescript") as Ts;
	if (!notes.length) notes.push("The project has no TypeScript installed, so the bundled TypeScript was used.");
	return { ts, engine: `typescript ${ts.version} (bundled)`, notes };
}

interface ProjectSetup {
	options: TS.CompilerOptions;
	files: string[];
	configFile?: string;
	notes: string[];
}

function loadProject(ts: Ts, config: Config): ProjectSetup {
	const notes: string[] = [];
	let setup: ProjectSetup | null = null;

	for (const name of ["tsconfig.json", "jsconfig.json"]) {
		const file = path.join(config.root, name);
		if (!fs.existsSync(file)) continue;
		const read = ts.readConfigFile(file, ts.sys.readFile);
		if (read.error) {
			notes.push(`${name} couldn't be read: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
			continue;
		}
		const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, config.root, undefined, file);
		let files = parsed.fileNames;
		let options = parsed.options;
		// A "solution" tsconfig lists no files of its own, only references.
		if (!files.length && parsed.projectReferences?.length) {
			files = [];
			for (const ref of parsed.projectReferences) {
				const refFile = ts.resolveProjectReferencePath(ref);
				const refRead = ts.readConfigFile(refFile, ts.sys.readFile);
				if (refRead.error) continue;
				const refParsed = ts.parseJsonConfigFileContent(refRead.config, ts.sys, path.dirname(refFile), undefined, refFile);
				if (!files.length) options = refParsed.options;
				files.push(...refParsed.fileNames);
			}
		}
		setup = { options, files, configFile: file, notes };
		break;
	}

	if (!setup) {
		const files = walk(config.root, {
			extensions: SOURCE_EXTENSIONS,
			exclude: config.exclude,
			skipDirs: ["vendor"],
		}).filter((file) => !/\.min\.[cm]?js$/.test(file));
		setup = {
			options: {
				allowJs: true,
				checkJs: false,
				jsx: ts.JsxEmit.ReactJSX,
				module: ts.ModuleKind.ESNext,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
				target: ts.ScriptTarget.ES2022,
				resolveJsonModule: true,
				esModuleInterop: true,
				allowSyntheticDefaultImports: true,
				skipLibCheck: true,
			},
			files,
			notes: [
				"No tsconfig.json or jsconfig.json in the root, so default options were used (JavaScript allowed, JSX react-jsx, bundler module resolution).",
			],
		};
	}

	if (config.include.length) {
		const extra = config.include.flatMap((dir) =>
			walk(dir, { extensions: SOURCE_EXTENSIONS, exclude: config.exclude, gitignore: true }),
		);
		setup.files = [...new Set([...setup.files, ...extra])];
	}
	setup.options = { ...setup.options, noEmit: true };
	return setup;
}

function isNodeModules(file: string): boolean {
	return file.includes("/node_modules/") || file.includes("\\node_modules\\");
}

/** Drop `import("/abs/path").` qualifiers the checker adds for types not in scope. */
function cleanTypeText(text: string): string {
	return text.replace(/import\("[^"]+"\)\./g, "");
}

/** `X | undefined` → `X` for optional fields, unwrapping `((a) => b) | undefined` too. */
function withoutUndefined(text: string): string {
	if (!text.endsWith(" | undefined")) return text;
	const rest = text.slice(0, -" | undefined".length);
	if (rest.startsWith("(") && rest.endsWith(")")) {
		let depth = 0;
		for (let i = 0; i < rest.length; i++) {
			if (rest[i] === "(") depth++;
			else if (rest[i] === ")") depth--;
			if (depth === 0 && i < rest.length - 1) return rest;
		}
		return rest.slice(1, -1);
	}
	return rest;
}

/** A long type shortened for a one-line header; the fields are listed separately. */
function shortType(text: string): string {
	if (text.length <= 80) return text;
	if (text.startsWith("{")) return "{ … }";
	const generic = /^[\w.$]+(<[^<>]*>)?/.exec(text)?.[0];
	return generic && generic.length <= 80 && generic.length < text.length ? `${generic} & …` : `${text.slice(0, 77)}…`;
}

/** `webpack://@scope/pkg/./src/File.tsx` → `src/File.tsx`. */
function cleanSourcePath(source: string): string {
	const withoutScheme = source.replace(/^[a-z]+:\/\//i, "");
	const dot = withoutScheme.indexOf("/./");
	return dot >= 0 ? withoutScheme.slice(dot + 3) : withoutScheme.replace(/^\.\//, "");
}

/** Source text of a default value on one line. */
function defaultText(text: string): string {
	return truncate(text.replace(/\s*\n\s*/g, " ").replace(/\[\s+/g, "[").replace(/\s+\]/g, "]").replace(/\{\s+/g, "{ ").replace(/\s+\}/g, " }"), 200);
}

/** Split "Class.member", "Class#member" or "Class::member". */
function splitMember(name: string): [string, string | undefined] {
	const match = /^(.+?)(?:\.|#|::)([^.#:]+)$/.exec(name);
	return match ? [match[1], match[2]] : [name, undefined];
}

interface OriginalSource {
	label: string;
	file: TS.SourceFile;
	declaration?: TS.Node;
	fn?: TS.SignatureDeclaration;
	doc?: string;
	propDocs: Map<string, string>;
}

interface FoundSymbol {
	symbol: TS.Symbol;
	/** Module specifier the symbol was imported from, when found through an import. */
	via?: string;
	/** Name to show when the symbol's own name is "default" (an anonymous default export). */
	displayName?: string;
}

export class TypeScriptAdapter implements LanguageAdapter {
	readonly language = "typescript";
	private readonly ts: Ts;
	private readonly engine: string;
	private readonly compilerNotes: string[];
	private setup: ProjectSetup;
	private readonly extraRoots = new Set<string>();
	private readonly service: TS.LanguageService;
	private readonly originals = new Map<string, OriginalSource | null>();
	private readonly sourceMapCache = new Map<string, { file: string; sources: string[]; contents: (string | null)[] }[]>();

	constructor(private readonly config: Config) {
		const compiler = loadCompiler(config.root);
		this.ts = compiler.ts;
		this.engine = compiler.engine;
		this.compilerNotes = compiler.notes;
		this.setup = loadProject(this.ts, this.config);
		this.service = this.ts.createLanguageService(this.host(), this.ts.createDocumentRegistry());
	}

	accepts(from: string): boolean {
		if (/\.php$/i.test(from) || from.includes("\\")) return false;
		return true;
	}

	// ---------------------------------------------------------------- setup

	/** The file list and tsconfig. Edits to known files need nothing here: the host reports each file's modification time as its version. */
	async sync(): Promise<void> {
		this.setup = loadProject(this.ts, this.config);
	}

	private host(): TS.LanguageServiceHost {
		const ts = this.ts;
		return {
			getScriptFileNames: () => [...this.setup.files, ...this.extraRoots],
			getScriptVersion: (file) => (isNodeModules(file) ? "0" : String(mtimeOf(file))),
			getScriptSnapshot: (file) => {
				try {
					return ts.ScriptSnapshot.fromString(fs.readFileSync(file, "utf8"));
				} catch {
					return undefined;
				}
			},
			getCurrentDirectory: () => this.config.root,
			getCompilationSettings: () => this.setup.options,
			getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
			fileExists: ts.sys.fileExists,
			readFile: ts.sys.readFile,
			readDirectory: ts.sys.readDirectory,
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
			realpath: ts.sys.realpath,
		};
	}

	private program(): TS.Program {
		const program = this.service.getProgram();
		if (!program) throw new Error("TypeScript couldn't build a program for this project.");
		return program;
	}

	private isLibFile(program: TS.Program, file: string): boolean {
		return program.isSourceFileDefaultLibrary(program.getSourceFile(file)!) || /[\\/]typescript[\\/]lib[\\/]lib\./.test(file);
	}

	/**
	 * Types an agent already knows, so they're never defined under `types:`:
	 * TypeScript's standard library, and React's own types (ReactNode,
	 * ReactElement, CSSProperties, RefAttributes), which are as widely known.
	 */
	private isKnownFile(program: TS.Program, file: string): boolean {
		return this.isLibFile(program, file) || KNOWN_TYPE_PACKAGES.test(file);
	}

	private isProjectFile(file: string): boolean {
		return !isNodeModules(file) && !/[\\/]typescript[\\/]lib[\\/]/.test(file);
	}

	private loc(node: TS.Node): string {
		const sf = node.getSourceFile();
		const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
		return `${relativeTo(this.config.root, sf.fileName)}:${line + 1}`;
	}

	// ------------------------------------------------------- symbol lookup

	/** Top-level declarations in project files whose name matches. */
	private projectDeclarations(program: TS.Program, name: string, onlyFile?: string): TS.Declaration[] {
		const ts = this.ts;
		const [head, member] = splitMember(name);
		const out: TS.Declaration[] = [];

		const visitStatements = (statements: readonly TS.Statement[]) => {
			for (const statement of statements) {
				if (ts.isVariableStatement(statement)) {
					for (const decl of statement.declarationList.declarations) {
						if (ts.isIdentifier(decl.name) && decl.name.text === head) out.push(decl);
					}
					continue;
				}
				if (ts.isModuleDeclaration(statement)) {
					if (statement.name.text === head) out.push(statement);
					if (statement.body && ts.isModuleBlock(statement.body)) visitStatements(statement.body.statements);
					continue;
				}
				if (
					(ts.isFunctionDeclaration(statement) ||
						ts.isClassDeclaration(statement) ||
						ts.isInterfaceDeclaration(statement) ||
						ts.isTypeAliasDeclaration(statement) ||
						ts.isEnumDeclaration(statement)) &&
					statement.name?.text === head
				) {
					out.push(statement);
				}
			}
		};

		for (const sf of program.getSourceFiles()) {
			if (!this.isProjectFile(sf.fileName)) continue;
			if (onlyFile && path.resolve(sf.fileName) !== onlyFile) continue;
			if (!sf.text.includes(head)) continue;
			visitStatements(sf.statements);
		}
		if (!member) return out;

		const members: TS.Declaration[] = [];
		for (const decl of out) {
			if (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)) {
				for (const m of decl.members) {
					if (m.name && ts.isIdentifier(m.name) && m.name.text === member) members.push(m);
				}
			}
		}
		return members;
	}

	/**
	 * Anonymous default exports (`export default function (props) {}`) have no
	 * name to search for, so match them by their file's name instead:
	 * `ContentWithMedia` finds the default export of `ContentWithMedia.tsx`.
	 */
	private defaultExportsNamed(program: TS.Program, checker: TS.TypeChecker, name: string): TS.Symbol[] {
		const out: TS.Symbol[] = [];
		for (const sf of program.getSourceFiles()) {
			if (!this.isProjectFile(sf.fileName) || sf.isDeclarationFile) continue;
			const base = path.basename(sf.fileName).replace(/\.[cm]?[jt]sx?$/, "");
			if (base !== name) continue;
			const moduleSymbol = checker.getSymbolAtLocation(sf);
			const exported = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((s) => s.name === "default");
			if (!exported) continue;
			const target = exported.flags & this.ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
			if (target.name === "default" || target.name === name) out.push(target);
		}
		return out;
	}

	/** Symbols imported into project files under this name, resolved to their declarations. */
	private importedSymbols(program: TS.Program, checker: TS.TypeChecker, name: string): FoundSymbol[] {
		const ts = this.ts;
		const out: FoundSymbol[] = [];
		for (const sf of program.getSourceFiles()) {
			if (!this.isProjectFile(sf.fileName) || !sf.text.includes(name)) continue;
			for (const statement of sf.statements) {
				if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
				const clause = statement.importClause;
				if (!clause) continue;
				const nodes: TS.Identifier[] = [];
				if (clause.name?.text === name) nodes.push(clause.name);
				if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
					for (const element of clause.namedBindings.elements) {
						if (element.name.text === name || element.propertyName?.getText(sf) === name) nodes.push(element.name);
					}
				}
				for (const node of nodes) {
					const local = checker.getSymbolAtLocation(node);
					if (!local) continue;
					const target = local.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(local) : local;
					if (!target.declarations?.length) continue;
					out.push({ symbol: target, via: statement.moduleSpecifier.text });
				}
			}
		}
		return out;
	}

	private resolveModule(specifier: string): { file?: string; error?: string } {
		const ts = this.ts;
		const asPath = path.resolve(this.config.root, specifier);
		if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) return { file: asPath };
		const containing = path.join(this.config.root, "__symbol_mcp__.ts");
		const resolved = ts.resolveModuleName(specifier, containing, this.setup.options, ts.sys);
		if (resolved.resolvedModule) return { file: resolved.resolvedModule.resolvedFileName };
		const bare = !specifier.startsWith(".") && !path.isAbsolute(specifier);
		if (bare) {
			const pkg = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
			if (!fs.existsSync(path.join(this.config.root, "node_modules", pkg))) {
				return { error: `Couldn't resolve "${specifier}": node_modules/${pkg} doesn't exist, so the package isn't installed.` };
			}
			return { error: `Couldn't resolve "${specifier}": node_modules/${pkg} exists but has no entry point or types for that path.` };
		}
		return { error: `Couldn't resolve "${specifier}" from the project root.` };
	}

	/** Source file for a resolved module, adding it to the program when no project file imports it. */
	private moduleFile(file: string): { program: TS.Program; sf?: TS.SourceFile } {
		let program = this.program();
		if (!program.getSourceFile(file)) {
			this.extraRoots.add(file);
			program = this.program();
		}
		return { program, sf: program.getSourceFile(file) };
	}

	private exportNamed(checker: TS.TypeChecker, sf: TS.SourceFile, name: string): TS.Symbol | undefined {
		const moduleSymbol = checker.getSymbolAtLocation(sf);
		if (!moduleSymbol) return undefined;
		const [head, member] = splitMember(name);
		const found = checker.getExportsOfModule(moduleSymbol).find((s) => s.name === head);
		if (!found) return undefined;
		const target = found.flags & this.ts.SymbolFlags.Alias ? checker.getAliasedSymbol(found) : found;
		if (!member) return target;
		const type = checker.getDeclaredTypeOfSymbol(target);
		return type.getProperty(member) ?? checker.getTypeOfSymbol(target).getProperty(member);
	}

	/** Look in installed dependencies whose type files mention the name. */
	private dependencySymbols(fullName: string): FoundSymbol[] {
		const [name] = splitMember(fullName);
		const pkg = readJson<Record<string, Record<string, string>>>(path.join(this.config.root, "package.json"));
		if (!pkg) return [];
		const deps = [
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.peerDependencies ?? {}),
			...Object.keys(pkg.devDependencies ?? {}),
		];
		const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
		const out: FoundSymbol[] = [];
		for (const dep of deps) {
			const dir = path.join(this.config.root, "node_modules", dep);
			if (!fs.existsSync(dir)) continue;
			const typeFiles = walk(dir, { extensions: [".ts"], exclude: [], gitignore: false }).slice(0, 2000);
			if (!typeFiles.some((f) => f.endsWith(".d.ts") && pattern.test(fs.readFileSync(f, "utf8")))) continue;
			const resolved = this.resolveModule(dep);
			if (!resolved.file) continue;
			const { program, sf } = this.moduleFile(resolved.file);
			if (!sf) continue;
			const symbol = this.exportNamed(program.getTypeChecker(), sf, fullName);
			if (symbol) out.push({ symbol, via: dep });
		}
		return out;
	}

	private findSymbols(name: string, from: string | undefined, notes: string[]): { program: TS.Program; found: FoundSymbol[] } {
		let program = this.program();
		let checker = program.getTypeChecker();
		const found: FoundSymbol[] = [];
		const add = (item: FoundSymbol) => {
			const existing = found.find((f) => f.symbol === item.symbol);
			if (!existing) found.push(item);
			// A symbol a project file also declares (a module augmentation) still has an import path.
			else if (item.via && !existing.via) existing.via = item.via;
		};

		if (from) {
			const resolved = this.resolveModule(from);
			if (!resolved.file) {
				notes.push(resolved.error!);
				return { program, found };
			}
			const local = this.isProjectFile(resolved.file) ? this.projectDeclarations(program, name, path.resolve(resolved.file)) : [];
			for (const decl of local) {
				const symbol = this.symbolOf(checker, decl);
				if (symbol) add({ symbol });
			}
			if (!found.length) {
				const mod = this.moduleFile(resolved.file);
				program = mod.program;
				checker = program.getTypeChecker();
				const symbol = mod.sf && this.exportNamed(checker, mod.sf, name);
				if (symbol) add({ symbol, via: from });
				else notes.push(`"${from}" doesn't export "${name}".`);
			}
			return { program, found };
		}

		for (const decl of this.projectDeclarations(program, name)) {
			const symbol = this.symbolOf(checker, decl);
			if (symbol) add({ symbol });
		}
		const [head, member] = splitMember(name);
		if (!member) for (const symbol of this.defaultExportsNamed(program, checker, head)) add({ symbol, displayName: head });
		for (const item of this.importedSymbols(program, checker, head)) {
			if (item.symbol.declarations?.every((d) => this.isProjectFile(d.getSourceFile().fileName))) continue;
			if (member) {
				const type = checker.getDeclaredTypeOfSymbol(item.symbol);
				const prop = type.getProperty(member) ?? checker.getTypeOfSymbol(item.symbol).getProperty(member);
				if (prop) add({ symbol: prop, via: item.via });
			} else {
				add({ ...item, displayName: head });
			}
		}
		if (!found.length) {
			for (const item of this.dependencySymbols(name)) add(item);
			program = this.program();
		}
		return { program, found };
	}

	private symbolOf(checker: TS.TypeChecker, decl: TS.Declaration): TS.Symbol | undefined {
		const nameNode = this.ts.getNameOfDeclaration(decl);
		return nameNode ? checker.getSymbolAtLocation(nameNode) : undefined;
	}

	// ------------------------------------------------- original sources

	/**
	 * For a declaration file in a package, find the original source code so
	 * defaults and docblocks the .d.ts dropped can be read. Checked in order:
	 * the declaration map, a src/ folder in the package, and the
	 * sourcesContent of the package's JavaScript source maps.
	 */
	private findOriginal(dtsFile: string, name: string): OriginalSource | null {
		const key = `${dtsFile}#${name}`;
		if (this.originals.has(key)) return this.originals.get(key)!;
		const found = this.locateOriginal(dtsFile);
		let result: OriginalSource | null = null;
		if (found) {
			const ts = this.ts;
			const ext = path.extname(found.path).toLowerCase();
			const kind =
				ext === ".tsx" ? ts.ScriptKind.TSX : ext === ".jsx" ? ts.ScriptKind.JSX : ext === ".js" || ext === ".mjs" || ext === ".cjs" ? ts.ScriptKind.JS : ts.ScriptKind.TS;
			const sf = ts.createSourceFile(found.path, found.text, ts.ScriptTarget.Latest, true, kind);
			const declaration = this.findDeclarationInFile(sf, name);
			const propDocs = new Map<string, string>();
			const visit = (node: TS.Node) => {
				if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) && ts.isIdentifier(node.name)) {
					const doc = this.jsDocText(node);
					if (doc && !propDocs.has(node.name.text)) propDocs.set(node.name.text, doc);
				}
				ts.forEachChild(node, visit);
			};
			visit(sf);
			result = {
				label: found.label,
				file: sf,
				declaration,
				fn: declaration ? this.functionLikeOf(declaration) : undefined,
				doc: declaration ? this.jsDocText(declaration) : undefined,
				propDocs,
			};
		}
		this.originals.set(key, result);
		return result;
	}

	private locateOriginal(dtsFile: string): { path: string; text: string; label: string } | null {
		const root = this.config.root;
		const base = path.basename(dtsFile).replace(/\.d\.[cm]?ts$/, "");
		const sourceName = new RegExp(`(^|/)${escapeRegExp(base)}\\.(tsx|ts|jsx|js|mjs|cjs)$`);

		// 1. Declaration map next to the .d.ts.
		const map = readJson<{ sources?: string[]; sourceRoot?: string; sourcesContent?: (string | null)[] }>(`${dtsFile}.map`);
		if (map?.sources?.length) {
			const abs = path.resolve(path.dirname(dtsFile), map.sourceRoot ?? "", map.sources[0]);
			if (fs.existsSync(abs)) return { path: abs, text: fs.readFileSync(abs, "utf8"), label: relativeTo(root, abs) };
			const content = map.sourcesContent?.[0];
			if (content) return { path: abs, text: content, label: `${relativeTo(root, `${dtsFile}.map`)} (sourcesContent)` };
		}

		const pkgRoot = this.packageRoot(dtsFile);
		if (!pkgRoot) return null;

		// 2. Sources shipped in the package.
		const srcDir = path.join(pkgRoot, "src");
		if (fs.existsSync(srcDir)) {
			const candidates = walk(srcDir, { extensions: SOURCE_EXTENSIONS, exclude: [], gitignore: false })
				.filter((f) => !f.endsWith(".d.ts") && sourceName.test(f.split(path.sep).join("/")))
				.sort((a, b) => a.length - b.length);
			if (candidates[0]) return { path: candidates[0], text: fs.readFileSync(candidates[0], "utf8"), label: relativeTo(root, candidates[0]) };
		}

		// 3. sourcesContent of the package's JavaScript source maps.
		for (const entry of this.packageSourceMaps(pkgRoot)) {
			const index = entry.sources.findIndex((s) => !s.includes("node_modules") && sourceName.test(cleanSourcePath(s)));
			if (index >= 0 && entry.contents[index]) {
				const cleaned = cleanSourcePath(entry.sources[index]);
				const pkgName = readJson<{ name?: string }>(path.join(pkgRoot, "package.json"))?.name ?? path.basename(pkgRoot);
				return {
					path: path.join(pkgRoot, cleaned),
					text: entry.contents[index]!,
					label: `${pkgName}/${cleaned} (from ${path.relative(pkgRoot, entry.file).split(path.sep).join("/")})`,
				};
			}
		}
		return null;
	}

	private packageRoot(file: string): string | null {
		let dir = path.dirname(file);
		while (true) {
			if (fs.existsSync(path.join(dir, "package.json"))) return dir;
			const parent = path.dirname(dir);
			if (parent === dir || path.basename(parent) === "node_modules") return null;
			dir = parent;
		}
	}

	private packageSourceMaps(pkgRoot: string) {
		const cached = this.sourceMapCache.get(pkgRoot);
		if (cached) return cached;
		const maps = walk(pkgRoot, { extensions: [".map"], exclude: [], gitignore: false, sizeLimit: false })
			.filter((f) => /\.[cm]?js\.map$/.test(f))
			.slice(0, 50);
		const entries = [];
		for (const file of maps) {
			const json = readJson<{ sources?: string[]; sourcesContent?: (string | null)[] }>(file);
			if (json?.sources && json.sourcesContent) entries.push({ file, sources: json.sources, contents: json.sourcesContent });
		}
		this.sourceMapCache.set(pkgRoot, entries);
		return entries;
	}

	private findDeclarationInFile(sf: TS.SourceFile, name: string): TS.Node | undefined {
		const ts = this.ts;
		let found: TS.Node | undefined;
		const visit = (statements: readonly TS.Statement[]) => {
			for (const statement of statements) {
				if (found) return;
				if (ts.isVariableStatement(statement)) {
					for (const decl of statement.declarationList.declarations) {
						if (ts.isIdentifier(decl.name) && decl.name.text === name) found = decl;
					}
				} else if (
					(ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
					statement.name?.text === name
				) {
					found = statement;
				} else if (ts.isModuleDeclaration(statement) && statement.body && ts.isModuleBlock(statement.body)) {
					visit(statement.body.statements);
				}
			}
		};
		visit(sf.statements);
		return found;
	}

	/** The function that implements a declaration: itself, a wrapped arrow (forwardRef, memo), or a class constructor. */
	private functionLikeOf(node: TS.Node): TS.SignatureDeclaration | undefined {
		const ts = this.ts;
		if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node)) {
			return node;
		}
		if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
			return node.members.find((m): m is TS.ConstructorDeclaration => ts.isConstructorDeclaration(m));
		}
		if (ts.isVariableDeclaration(node) && node.initializer) return this.functionLikeOf(node.initializer);
		if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return this.functionLikeOf(node.expression);
		if (ts.isCallExpression(node)) {
			for (const arg of node.arguments) {
				const fn = this.functionLikeOf(arg);
				if (fn) return fn;
			}
		}
		return undefined;
	}

	private jsDocText(node: TS.Node): string | undefined {
		const ts = this.ts;
		for (const item of ts.getJSDocCommentsAndTags(node)) {
			if (ts.isJSDoc(item)) {
				const text = ts.getTextOfJSDocComment(item.comment);
				if (text?.trim()) return text.trim();
			}
		}
		return undefined;
	}

	/** Defaults declared by a parameter: its own initializer, and initializers inside an object destructuring. */
	private parameterDefaults(param: TS.ParameterDeclaration | undefined): { own?: string; props: Record<string, string> } {
		const ts = this.ts;
		const props: Record<string, string> = {};
		if (!param) return { props };
		if (ts.isObjectBindingPattern(param.name)) {
			for (const element of param.name.elements) {
				if (!element.initializer) continue;
				const key = element.propertyName ? element.propertyName.getText() : element.name.getText();
				props[key] = defaultText(element.initializer.getText());
			}
		}
		return { own: param.initializer ? defaultText(param.initializer.getText()) : undefined, props };
	}

	// ----------------------------------------------------------- describe

	private docOf(checker: TS.TypeChecker, symbol: TS.Symbol): string | undefined {
		const text = this.ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
		return text || undefined;
	}

	/** `definition` prints what an alias stands for instead of its name (for describing the alias itself). */
	private typeText(checker: TS.TypeChecker, type: TS.Type, enclosing?: TS.Node, optional = false, definition = false): string {
		const flags = this.ts.TypeFormatFlags.NoTruncation | (definition ? this.ts.TypeFormatFlags.InTypeAlias : 0);
		let text = cleanTypeText(checker.typeToString(type, enclosing, flags));
		if (optional) text = withoutUndefined(text);
		return truncate(text);
	}

	/**
	 * Not part of TypeScript's standard library, so the agent may not know it.
	 * A standard type that a package redeclares (`@types/node` declares `Event`
	 * and `EventTarget` too) still counts as standard.
	 */
	private isCustom(program: TS.Program, symbol: TS.Symbol | undefined): boolean {
		const decls = symbol?.declarations ?? [];
		if (!decls.length) return false;
		return !decls.some((d) => this.isKnownFile(program, d.getSourceFile().fileName));
	}

	/** Declared only in @types packages. These are defined after the project's and packages' own types. */
	private fromTypesPackage(type: TS.Type): boolean {
		const decls = (type.aliasSymbol ?? type.getSymbol())?.declarations ?? [];
		return decls.length > 0 && decls.every((d) => /[\\/]node_modules[\\/]@types[\\/]/.test(d.getSourceFile().fileName));
	}

	/** An object type with no name of its own: a type literal, an object literal, or an unnamed intersection. */
	private isAnonymous(type: TS.Type): boolean {
		const symbol = type.aliasSymbol ?? type.getSymbol();
		return !symbol || symbol.name.startsWith("__");
	}

	/**
	 * The named parts a props type is built from: the members of an
	 * intersection, or the base types an interface extends. Unnamed parts (the
	 * `{ … }` literal holding the component's own props) are left out.
	 */
	private typeParts(checker: TS.TypeChecker, type: TS.Type): { type: TS.Type; label: string }[] {
		const ts = this.ts;
		let members: readonly TS.Type[] = [];
		if (type.isIntersection()) members = type.types;
		else if (((type as TS.ObjectType).objectFlags ?? 0) & (ts.ObjectFlags.Interface | ts.ObjectFlags.Class)) members = checker.getBaseTypes(type as TS.InterfaceType);
		return members
			.filter((member) => !this.isAnonymous(member) || member.aliasSymbol)
			.map((member) => ({ type: member, label: cleanTypeText(checker.typeToString(member, undefined, ts.TypeFormatFlags.NoTruncation)) }));
	}

	/**
	 * Find the custom types a type refers to by name and queue each one once
	 * for the `types:` section. Walks unions, intersections, type arguments
	 * (`Item[]`, `Record<string, Item>`, `Promise<Item>`), callback parameters
	 * and return types, and the properties of unnamed object types.
	 */
	private collectTypes(checker: TS.TypeChecker, program: TS.Program, type: TS.Type, level: number, ctx: TypeContext, insideOf?: TS.Type): void {
		const ts = this.ts;
		const visited = new Set<TS.Type>();
		const visit = (t: TS.Type) => {
			if (visited.has(t)) return;
			visited.add(t);
			// An optional prop's type is `Alias | undefined`; strip undefined so the alias name is seen.
			if (t.isUnion()) {
				const required = checker.getNonNullableType(t);
				if (required !== t) {
					visit(required);
					return;
				}
			}
			// A named custom alias of anything but an object type (a union, a tuple, a function type)
			// is defined by what it stands for. `insideOf` walks an alias's own parts instead.
			if (t !== insideOf && t.aliasSymbol && this.isCustom(program, t.aliasSymbol) && !this.isExpandable(checker, program, t)) {
				ctx.enqueue(t, level);
				return;
			}
			if (t.isUnion() || t.isIntersection()) {
				if (t !== insideOf && t.aliasSymbol && this.isCustom(program, t.aliasSymbol)) {
					ctx.enqueue(t, level);
					return;
				}
				for (const member of t.types) visit(member);
				return;
			}
			if (!(t.flags & ts.TypeFlags.Object)) return;
			const objectType = t as TS.ObjectType;
			if (objectType.objectFlags & ts.ObjectFlags.Reference) {
				for (const arg of checker.getTypeArguments(t as TS.TypeReference)) visit(arg);
			}
			for (const arg of t.aliasTypeArguments ?? []) visit(arg);
			for (const sig of t.getCallSignatures().slice(0, 3)) {
				for (const param of sig.getParameters()) visit(checker.getTypeOfSymbolAtLocation(param, ctx.anchor));
				visit(sig.getReturnType());
			}
			const symbol = t.aliasSymbol ?? t.getSymbol();
			const hasProps = checker.getPropertiesOfType(t).length > 0;
			if (!this.isAnonymous(t)) {
				if (hasProps && this.isCustom(program, symbol) && this.isExpandable(checker, program, t)) ctx.enqueue(t, level);
				return;
			}
			for (const prop of checker.getPropertiesOfType(t)) visit(checker.getTypeOfSymbolAtLocation(prop, ctx.anchor));
		};
		visit(type);
	}

	/** Define each queued type, in the order first referenced, down to `maxLevel` hops. */
	private buildTypes(checker: TS.TypeChecker, program: TS.Program, ctx: TypeContext, maxLevel: number, original: OriginalSource | null): { types: TypeEntry[]; omitted: string[] } {
		const ts = this.ts;
		const types: TypeEntry[] = [];
		const late: TypeEntry[] = [];
		const omitted: string[] = [];
		const names = new Set<string>();
		while (ctx.queue.length && types.length + late.length < MAX_TYPE_ENTRIES) {
			const { type: used, level } = ctx.queue.shift()!;
			// Define a generic once, in its declared form (`Transform<T>`); each use shows its own arguments.
			const declaredSymbol = used.aliasSymbol ?? used.getSymbol();
			const type =
				declaredSymbol && declaredSymbol.flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface | ts.SymbolFlags.Class)
					? checker.getDeclaredTypeOfSymbol(declaredSymbol)
					: used;
			const name = cleanTypeText(checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation));
			// Overloads and repeated generic uses make separate copies of one type; define it once.
			if (names.has(name)) continue;
			names.add(name);
			if (level > maxLevel) {
				omitted.push(name);
				continue;
			}
			const out = this.fromTypesPackage(type) ? late : types;
			const symbol = type.aliasSymbol ?? type.getSymbol();
			const doc = symbol ? firstLine(this.docOf(checker, symbol)) : undefined;
			if (type.aliasSymbol && !this.isExpandable(checker, program, type)) {
				// Prefer the alias as written (`ComponentType<{ … }>`) over the compiler's expansion of it.
				const aliasDecl = type.aliasSymbol?.declarations?.find((d): d is TS.TypeAliasDeclaration => ts.isTypeAliasDeclaration(d));
				const definition = aliasDecl
					? aliasDecl.type.getText().replace(/\s+/g, " ")
					: cleanTypeText(checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias));
				// A definition this long is a machine expansion nobody can read; name it instead.
				if (definition.length > MAX_DEFINITION) {
					omitted.push(`${name} (${definition.length} chars)`);
					continue;
				}
				out.push({ name, definition, doc, level });
				this.collectTypes(checker, program, type, level + 1, ctx, type);
				continue;
			}
			// An interface that adds nothing to what it extends (`interface TemplateArray extends
			// ReadonlyArray<Template> {}`) is defined by its base types, not by their inherited members.
			const ownProps = checker.getPropertiesOfType(type).filter((p) => p.declarations?.some((d) => !this.isKnownFile(program, d.getSourceFile().fileName)));
			const objectFlags = (type as TS.ObjectType).objectFlags ?? 0;
			if (!ownProps.length && objectFlags & (ts.ObjectFlags.Interface | ts.ObjectFlags.Class)) {
				const bases = checker.getBaseTypes(type as TS.InterfaceType);
				if (bases.length) {
					const definition = bases.map((b) => cleanTypeText(checker.typeToString(b, undefined, ts.TypeFormatFlags.NoTruncation))).join(" & ");
					out.push({ name, definition: truncate(definition, MAX_DEFINITION), doc, level });
					for (const base of bases) this.collectTypes(checker, program, base, level + 1, ctx);
					continue;
				}
			}
			// A type with hundreds of props (CSSProperties, a DOM interface) would crowd out everything else.
			const propCount = checker.getPropertiesOfType(type).length;
			if (propCount > MAX_FIELDS) {
				omitted.push(`${name} (${propCount} props)`);
				continue;
			}
			const expanded = this.fields(checker, program, type, ctx.anchor, {}, original, ctx, level);
			out.push({ name, fields: expanded.fields, inherited: expanded.inherited, doc, level });
		}
		omitted.push(...ctx.queue.map((item) => cleanTypeText(checker.typeToString(item.type, undefined, ts.TypeFormatFlags.NoTruncation))));
		// Closest types first; within one hop, the project's and packages' own types before @types ones.
		const lateSet = new Set(late);
		const ordered = [...types, ...late].sort((a, b) => a.level - b.level || Number(lateSet.has(a)) - Number(lateSet.has(b)));
		return { types: ordered, omitted };
	}

	private isExpandable(checker: TS.TypeChecker, program: TS.Program, type: TS.Type): boolean {
		const ts = this.ts;
		const t = checker.getNonNullableType(type);
		if (t.isUnion()) return false;
		if (!(t.flags & ts.TypeFlags.Object) && !t.isIntersection()) return false;
		const scalar =
			ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike |
			ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.EnumLike;
		if (t.flags & scalar) return false;
		if (t.getCallSignatures().length || t.getConstructSignatures().length) return false;
		const checkerExtra = checker as unknown as { isArrayType?: (t: TS.Type) => boolean; isTupleType?: (t: TS.Type) => boolean };
		if (checkerExtra.isArrayType?.(t) || checkerExtra.isTupleType?.(t)) return false;
		const symbol = t.aliasSymbol ?? t.getSymbol();
		const decls = symbol?.declarations ?? [];
		if (decls.some((d) => this.isKnownFile(program, d.getSourceFile().fileName))) return false;
		return checker.getPropertiesOfType(t).length > 0;
	}

	/**
	 * The properties of an object type, one level only. Custom types the
	 * properties use are queued for the `types:` section at `level + 1`.
	 */
	private fields(
		checker: TS.TypeChecker,
		program: TS.Program,
		type: TS.Type,
		anchor: TS.Node,
		defaults: Record<string, string>,
		original: OriginalSource | null,
		ctx: TypeContext,
		level: number,
	): { fields: Field[]; inherited?: { from: string; count: number }[] } {
		const ts = this.ts;
		const t = checker.getNonNullableType(type);
		const props = checker.getPropertiesOfType(checker.getApparentType(t));
		let own = props;
		let inherited: { from: string; count: number }[] | undefined;

		// Props from the standard library or @types packages (DOM attributes, React's key and ref) are
		// grouped by origin whenever the type has props of its own, or when there are too many to list.
		const isExternal = (prop: TS.Symbol) => {
			const decl = prop.declarations?.[0];
			const file = decl?.getSourceFile().fileName ?? "";
			return !decl || this.isLibFile(program, file) || /[\\/]node_modules[\\/]@types[\\/]/.test(file);
		};
		const ownCount = props.filter((p) => !isExternal(p)).length;
		if (ownCount > 0 || props.length > MAX_FIELDS) {
			own = [];
			// Name each group by the part of the type expression that brought the props in, as the code
			// writes it (`Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "onChange">`, `RefAttributes<T>`):
			// a member of the intersection, or a base type the interface extends. The interfaces those
			// props happen to be declared in (DOMAttributes, AriaAttributes) only add lines.
			const parts = this.typeParts(checker, t);
			const groups = new Map<string, number>();
			for (const prop of props) {
				const decl = prop.declarations?.[0];
				const file = decl?.getSourceFile().fileName ?? "";
				if (!isExternal(prop)) {
					own.push(prop);
					continue;
				}
				const part = parts.find((p) => checker.getPropertyOfType(p.type, prop.name));
				const parent = decl?.parent;
				const from = part
					? part.label
					: parent && (ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name
						? parent.name.text
						: relativeTo(this.config.root, file);
				groups.set(from, (groups.get(from) ?? 0) + 1);
			}
			if (groups.size) inherited = [...groups].map(([from, count]) => ({ from, count })).sort((a, b) => b.count - a.count);
		}

		const anchorFile = anchor.getSourceFile().fileName;
		const fields = own.map((prop): Field => {
			const decl = prop.valueDeclaration ?? prop.declarations?.[0];
			const propType = checker.getTypeOfSymbolAtLocation(prop, anchor);
			const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
			const field: Field = {
				name: prop.name,
				type: this.typeText(checker, propType, anchor, optional),
				optional: optional || undefined,
				default: defaults[prop.name],
				doc: this.docOf(checker, prop) ?? original?.propDocs.get(prop.name),
			};
			if (decl && decl.getSourceFile().fileName !== anchorFile) field.declaredIn = this.loc(decl);
			this.collectTypes(checker, program, propType, level + 1, ctx);
			return field;
		});
		return { fields, inherited };
	}

	private signature(
		checker: TS.TypeChecker,
		program: TS.Program,
		name: string,
		sig: TS.Signature,
		anchor: TS.Node,
		implementation: TS.SignatureDeclaration | undefined,
		isComponent: boolean,
		depth: number,
		original: OriginalSource | null,
		ctx: TypeContext,
	): Signature {
		const ts = this.ts;
		const text = truncate(cleanTypeText(`${name}${checker.signatureToString(sig, undefined, ts.TypeFormatFlags.NoTruncation)}`), 1000);
		const sigDecl = sig.getDeclaration() as TS.SignatureDeclaration | undefined;
		const paramTags = new Map<string, string>();
		for (const tag of sig.getJsDocTags()) {
			if (tag.name !== "param" || !tag.text) continue;
			const parts = tag.text;
			const paramName = parts.find((p) => p.kind === "parameterName")?.text;
			const doc = parts.filter((p) => p.kind === "text").map((p) => p.text).join("").replace(/^\s*-\s*/, "").trim();
			if (paramName && doc) paramTags.set(paramName, doc);
		}

		const params = sig.getParameters().map((param, index): Field => {
			const pdecl = param.valueDeclaration as TS.ParameterDeclaration | undefined;
			const ptype = checker.getTypeOfSymbolAtLocation(param, pdecl ?? anchor);
			const ownDecl = pdecl && sigDecl && pdecl.parent === sigDecl && !pdecl.getSourceFile().isDeclarationFile ? pdecl : undefined;
			const implParam = implementation?.parameters[index];
			let pname = param.name;
			if (pname.startsWith("__")) {
				// A destructured parameter: name it by its pattern, or "props" for a component's props object.
				const pattern = (ownDecl ?? implParam)?.name;
				pname = isComponent && index === 0 ? "props" : pattern && !ts.isIdentifier(pattern) ? truncate(pattern.getText().replace(/\s+/g, " "), 80) : `arg${index}`;
			}
			const defaults = this.parameterDefaults(ownDecl ?? implParam);
			const optional = (pdecl ? checker.isOptionalParameter(pdecl) : false) || defaults.own !== undefined;
			const field: Field = {
				name: pdecl?.dotDotDotToken ? `...${pname}` : pname,
				type: this.typeText(checker, ptype, anchor, optional),
				optional: optional || undefined,
				default: defaults.own,
				doc: this.docOf(checker, param) ?? paramTags.get(param.name),
			};
			// List a parameter's fields under it when they're the subject (a component's props), when its
			// type has no name to define elsewhere, or when destructuring gives its fields defaults.
			// Otherwise the parameter refers to its type by name and the type goes in `types:`.
			const inner = checker.getNonNullableType(ptype);
			const inline =
				depth > 0 &&
				this.isExpandable(checker, program, inner) &&
				((isComponent && index === 0) || this.isAnonymous(inner) || Object.keys(defaults.props).length > 0);
			if (inline) {
				ctx.exclude(inner);
				// `HeadingProps & RefAttributes<…>`: HeadingProps's fields are listed here too, so a later
				// reference to it (`onChange: (v: Partial<HeadingProps>) => void`) mustn't define it again.
				if (inner.isIntersection()) for (const member of inner.types) ctx.exclude(member);
				const expanded = this.fields(checker, program, inner, anchor, defaults.props, original, ctx, 1);
				field.fields = expanded.fields;
				if (expanded.inherited) field.inherited = expanded.inherited;
			} else if (depth > 0) {
				this.collectTypes(checker, program, ptype, 1, ctx);
			}
			return field;
		});

		const returnTag = sig.getJsDocTags().find((t) => t.name === "returns" || t.name === "return");
		const returnType = this.typeText(checker, sig.getReturnType(), anchor);
		// A component returns its framework's element type (JSX.Element, ReactNode), which the agent
		// already knows and never builds; a function's return type is often a custom type it needs.
		if (depth > 0 && !isComponent) this.collectTypes(checker, program, sig.getReturnType(), 1, ctx);

		// Inline object types repeat every field listed below them; keep the header readable.
		for (const param of params) {
			if (param.fields?.length && param.type && param.type.length > 120) param.type = shortType(param.type);
		}
		const header =
			text.length > 240
				? `${name}(${params.map((p) => `${p.name}${p.optional ? "?" : ""}: ${shortType(p.type ?? "unknown")}`).join(", ")}): ${shortType(returnType)}`
				: text;
		return {
			text: header,
			params,
			returns: {
				type: returnType,
				doc: returnTag?.text ? ts.displayPartsToString(returnTag.text).trim() || undefined : undefined,
			},
		};
	}

	private unresolvedImports(sf: TS.SourceFile): string[] {
		const ts = this.ts;
		const missing: string[] = [];
		for (const statement of sf.statements) {
			if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue;
			const spec = statement.moduleSpecifier;
			if (!spec || !ts.isStringLiteral(spec)) continue;
			if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp)(\?.*)?$/.test(spec.text)) continue;
			const resolved = ts.resolveModuleName(spec.text, sf.fileName, this.setup.options, ts.sys);
			if (!resolved.resolvedModule) missing.push(spec.text);
		}
		return missing;
	}

	private describeSymbol(checker: TS.TypeChecker, program: TS.Program, found: FoundSymbol, depth: number): SymbolInfo | null {
		const ts = this.ts;
		let symbol = found.symbol;
		if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
		const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
		if (!decl) return null;
		const sf = decl.getSourceFile();
		const notes: string[] = [];

		const original = sf.isDeclarationFile && isNodeModules(sf.fileName) ? this.findOriginal(sf.fileName, symbol.name) : null;
		if (!original && sf.isDeclarationFile && isNodeModules(sf.fileName)) {
			notes.push("Only the declaration file was available (no source map or package sources), so default values aren't shown.");
		}

		const missing = this.unresolvedImports(sf);
		if (missing.length) {
			notes.push(`Imports that didn't resolve in ${relativeTo(this.config.root, sf.fileName)}: ${missing.join(", ")}. Types that come from them show as any.`);
			notes.push(...this.missingPackagesNotes());
		}

		const shownName = symbol.name === "default" ? found.displayName ?? "default" : symbol.name;
		const info: SymbolInfo = {
			name: shownName,
			kind: "symbol",
			language: "typescript",
			location: this.loc(decl),
			source: original?.label,
			importFrom: found.via,
			dependency: isNodeModules(sf.fileName) || undefined,
			doc: this.docOf(checker, symbol) ?? original?.doc ?? (decl ? this.jsDocText(decl) : undefined),
			resolution: { engine: this.engine, status: missing.length ? "partial" : "full", notes, info: [] },
		};
		const tags = symbol.getJsDocTags(checker)
			.filter((t) => t.name !== "param" && t.name !== "returns" && t.name !== "return")
			.map((t) => ({ name: t.name, text: ts.displayPartsToString(t.text ?? []).trim() }));
		if (tags.length) info.tags = tags;

		const implementation = original?.fn ?? (!sf.isDeclarationFile ? this.functionLikeOf(decl) : undefined);
		const flags = symbol.flags;
		const ctx = new TypeContext(decl);
		const finish = (): SymbolInfo => {
			if (depth <= 0) return info;
			const { types, omitted } = this.buildTypes(checker, program, ctx, depth, original);
			if (types.length) info.types = types;
			if (omitted.length) info.typesOmitted = omitted;
			return info;
		};

		if (flags & ts.SymbolFlags.Class) {
			info.kind = "class";
			ctx.exclude(checker.getDeclaredTypeOfSymbol(symbol));
			const staticType = checker.getTypeOfSymbolAtLocation(symbol, decl);
			const ctors = staticType.getConstructSignatures().slice(0, MAX_OVERLOADS);
			if (ctors.length) {
				info.signatures = ctors.map((sig) => this.signature(checker, program, `new ${shownName}`, sig, decl, implementation, false, depth, original, ctx));
			}
			info.members = this.classMembers(checker, symbol, decl);
			return finish();
		}

		if (flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) {
			info.kind = flags & ts.SymbolFlags.Interface ? "interface" : "type";
			const type = checker.getDeclaredTypeOfSymbol(symbol);
			ctx.exclude(type);
			if (info.kind === "type") info.type = this.typeText(checker, type, decl, false, true);
			const calls = type.getCallSignatures();
			if (calls.length && !checker.getPropertiesOfType(type).length) {
				info.signatures = calls.slice(0, MAX_OVERLOADS).map((sig) => this.signature(checker, program, shownName, sig, decl, undefined, false, depth, original, ctx));
			} else if (depth > 0 && this.isExpandable(checker, program, type)) {
				const expanded = this.fields(checker, program, type, decl, {}, original, ctx, 1);
				info.fields = expanded.fields;
				if (expanded.inherited) info.inherited = expanded.inherited;
			} else if (depth > 0) {
				if (type.isUnion()) for (const member of type.types) this.collectTypes(checker, program, member, 1, ctx);
				else this.collectTypes(checker, program, type, 1, ctx);
			}
			return finish();
		}

		if (flags & ts.SymbolFlags.Enum) {
			info.kind = "enum";
			info.members = (symbol.exports ? [...(symbol.exports as Map<string, TS.Symbol>).values()] : []).map((member) => {
				const memberDecl = member.valueDeclaration as TS.EnumMember | undefined;
				const value = memberDecl ? checker.getConstantValue(memberDecl) : undefined;
				return { name: member.name, kind: "enum member", signature: value !== undefined ? JSON.stringify(value) : undefined, summary: firstLine(this.docOf(checker, member)) };
			});
			return info;
		}

		if (flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Method | ts.SymbolFlags.Variable | ts.SymbolFlags.Property)) {
			const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
			const calls = type.getCallSignatures();
			if (calls.length) {
				const returns = checker.typeToString(calls[0].getReturnType());
				const ext = path.extname(sf.fileName).toLowerCase();
				const isComponent = /^[A-Z]/.test(shownName) && (/Element|ReactNode|JSX/.test(returns) || ext === ".tsx" || ext === ".jsx");
				info.kind = isComponent ? "component" : flags & ts.SymbolFlags.Method ? "method" : "function";
				info.signatures = calls
					.slice(0, MAX_OVERLOADS)
					.map((sig) => this.signature(checker, program, shownName, sig, decl, implementation, isComponent, depth, original, ctx));
				if (/\.(js|jsx|mjs|cjs)$/.test(sf.fileName) && info.signatures.some((s) => s.params.some((p) => p.type === "any"))) {
					info.resolution.notes.push("Parameters typed any have no JSDoc type in this JavaScript file, so their types aren't declared.");
				}
				if (calls.length > MAX_OVERLOADS) info.resolution.notes.push(`Showing ${MAX_OVERLOADS} of ${calls.length} overloads.`);
				return finish();
			}
			const isConst = ts.isVariableDeclaration(decl) && (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
			info.kind = flags & ts.SymbolFlags.Property ? "property" : isConst ? "constant" : "variable";
			info.type = this.typeText(checker, type, decl);
			if (depth > 0 && this.isExpandable(checker, program, type) && this.isAnonymous(type)) {
				ctx.exclude(type);
				const expanded = this.fields(checker, program, type, decl, {}, original, ctx, 1);
				info.fields = expanded.fields;
				if (expanded.inherited) info.inherited = expanded.inherited;
			} else if (depth > 0) {
				this.collectTypes(checker, program, type, 1, ctx);
			}
			return finish();
		}

		if (flags & ts.SymbolFlags.Module) {
			info.kind = "namespace";
			info.members = checker.getExportsOfModule(symbol).map((member) => this.summarize(checker, member));
			return info;
		}
		return info;
	}

	private classMembers(checker: TS.TypeChecker, symbol: TS.Symbol, decl: TS.Node): MemberSummary[] {
		const ts = this.ts;
		const out: MemberSummary[] = [];
		const isPublic = (member: TS.Symbol) => {
			if (member.name.startsWith("#") || member.name === "prototype") return false;
			const d = member.valueDeclaration ?? member.declarations?.[0];
			if (!d) return true;
			const mods = ts.getCombinedModifierFlags(d as TS.Declaration);
			return !(mods & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
		};
		const add = (member: TS.Symbol, isStatic: boolean) => {
			if (!isPublic(member)) return;
			const type = checker.getTypeOfSymbolAtLocation(member, decl);
			const calls = type.getCallSignatures();
			const isMethod = (member.flags & ts.SymbolFlags.Method) !== 0 || (calls.length > 0 && !(member.flags & ts.SymbolFlags.Property));
			const d = member.valueDeclaration ?? member.declarations?.[0];
			out.push({
				name: isStatic ? `static ${member.name}` : member.name,
				kind: isMethod ? "method" : "property",
				signature: isMethod && calls[0]
					? truncate(`${member.name}${checker.signatureToString(calls[0], undefined, ts.TypeFormatFlags.NoTruncation)}`, 300)
					: truncate(this.typeText(checker, type, decl), 300),
				summary: firstLine(this.docOf(checker, member)),
				location: d ? this.loc(d) : undefined,
			});
		};
		for (const member of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))) add(member, false);
		for (const member of checker.getPropertiesOfType(checker.getTypeOfSymbolAtLocation(symbol, decl))) add(member, true);
		return out;
	}

	private summarize(checker: TS.TypeChecker, exported: TS.Symbol): MemberSummary {
		const ts = this.ts;
		const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
		const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
		const name = exported.name === "default" && symbol.name !== "default" ? `default (${symbol.name})` : exported.name;
		const summary: MemberSummary = { name, kind: "symbol", summary: firstLine(this.docOf(checker, symbol)), location: decl ? this.loc(decl) : undefined };
		const flags = symbol.flags;
		if (flags & ts.SymbolFlags.Class) summary.kind = "class";
		else if (flags & ts.SymbolFlags.Interface) summary.kind = "interface";
		else if (flags & ts.SymbolFlags.TypeAlias) summary.kind = "type";
		else if (flags & ts.SymbolFlags.Enum) summary.kind = "enum";
		else if (flags & ts.SymbolFlags.Module) summary.kind = "namespace";
		else if (decl && flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable)) {
			const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
			const call = type.getCallSignatures()[0];
			if (call) {
				const returns = checker.typeToString(call.getReturnType());
				summary.kind = /^[A-Z]/.test(symbol.name) && /Element|ReactNode|JSX/.test(returns) ? "component" : "function";
				summary.signature = truncate(`${symbol.name}${checker.signatureToString(call, undefined, ts.TypeFormatFlags.NoTruncation)}`, 300);
			} else {
				summary.kind = "variable";
				summary.signature = truncate(this.typeText(checker, type, decl), 300);
			}
		}
		return summary;
	}

	async describe(name: string, options: DescribeOptions): Promise<SymbolInfo[]> {
		const notes: string[] = [];
		const { program, found } = this.findSymbols(name, options.from, notes);
		const checker = program.getTypeChecker();
		const out: SymbolInfo[] = [];
		for (const item of found) {
			const info = this.describeSymbol(checker, program, item, options.depth);
			if (!info) continue;
			info.resolution.info = [...this.compilerNotes, ...this.setup.notes];
			out.push(info);
		}
		if (!out.length && notes.length) {
			out.push({
				name,
				kind: "unresolved",
				language: "typescript",
				location: "",
				resolution: { engine: this.engine, status: "partial", notes: [...notes, ...this.missingPackagesNotes()] },
			});
		}
		return out;
	}

	async declarations(name: string): Promise<DeclarationRef[]> {
		const program = this.program();
		const checker = program.getTypeChecker();
		const kindOf = (decl: TS.Node) => this.ts.SyntaxKind[decl.kind].replace(/Declaration$/, "").toLowerCase();
		const refs: DeclarationRef[] = this.projectDeclarations(program, name).map((decl) => ({
			name: this.symbolOf(checker, decl)?.name ?? name,
			kind: kindOf(decl),
			language: "typescript",
			location: this.loc(decl),
		}));
		const [head] = splitMember(name);
		for (const item of this.importedSymbols(program, checker, head)) {
			const decl = item.symbol.valueDeclaration ?? item.symbol.declarations?.[0];
			if (!decl || this.isProjectFile(decl.getSourceFile().fileName)) continue;
			const location = this.loc(decl);
			if (!refs.some((r) => r.location === location)) refs.push({ name: `${item.symbol.name} (from "${item.via}")`, kind: kindOf(decl), language: "typescript", location });
		}
		return refs;
	}

	private missingPackagesNotes(): string[] {
		const pkg = readJson<Record<string, Record<string, string>>>(path.join(this.config.root, "package.json"));
		const hasDeps = pkg && Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
		if (hasDeps && !fs.existsSync(path.join(this.config.root, "node_modules"))) {
			return ["node_modules doesn't exist, so imported packages can't be resolved. Install the project's dependencies to describe them."];
		}
		return [];
	}

	// ------------------------------------------------------------ exports

	async exports(target: string): Promise<ExportsResult | null> {
		if (!this.accepts(target)) return null;
		const resolved = this.resolveModule(target);
		const resolution: Resolution = { engine: this.engine, status: "full", notes: [], info: [...this.compilerNotes] };
		if (!resolved.file) {
			return { target, language: "typescript", exports: [], resolution: { ...resolution, status: "partial", notes: [resolved.error!] } };
		}
		const { program, sf } = this.moduleFile(resolved.file);
		if (!sf) return null;
		const checker = program.getTypeChecker();
		const moduleSymbol = checker.getSymbolAtLocation(sf);
		let exports: MemberSummary[];
		if (moduleSymbol) {
			exports = checker.getExportsOfModule(moduleSymbol).map((s) => this.summarize(checker, s));
		} else {
			resolution.notes.push("This file isn't a module (no imports or exports), so its top-level declarations are listed.");
			exports = [];
			for (const statement of sf.statements) {
				const names = this.ts.isVariableStatement(statement)
					? statement.declarationList.declarations.map((d) => d.name)
					: [(statement as TS.DeclarationStatement).name].filter(Boolean);
				for (const nameNode of names) {
					const symbol = nameNode && checker.getSymbolAtLocation(nameNode);
					if (symbol) exports.push(this.summarize(checker, symbol));
				}
			}
		}
		const missing = this.unresolvedImports(sf);
		if (missing.length) {
			resolution.status = "partial";
			resolution.notes.push(`Imports that didn't resolve: ${missing.join(", ")}.`);
		}
		return { target, language: "typescript", location: relativeTo(this.config.root, sf.fileName), exports, resolution };
	}

	// ------------------------------------------------------------- usages

	private nodeAt(sf: TS.SourceFile, pos: number): TS.Node | undefined {
		let found: TS.Node | undefined;
		const visit = (node: TS.Node) => {
			if (pos >= node.getStart(sf) && pos < node.getEnd()) {
				found = node;
				this.ts.forEachChild(node, visit);
			}
		};
		this.ts.forEachChild(sf, visit);
		return found;
	}

	private usageContext(sf: TS.SourceFile, node: TS.Node): { skip: boolean; node: TS.Node } {
		const ts = this.ts;
		let current: TS.Node | undefined = node;
		for (let i = 0; current && i < 8; i++, current = current.parent) {
			if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current) || ts.isExportAssignment(current) || ts.isImportEqualsDeclaration(current)) {
				return { skip: true, node };
			}
			if (
				ts.isCallExpression(current) ||
				ts.isNewExpression(current) ||
				ts.isJsxSelfClosingElement(current) ||
				ts.isJsxOpeningElement(current) ||
				ts.isDecorator(current) ||
				ts.isHeritageClause(current) ||
				ts.isTaggedTemplateExpression(current)
			) {
				return { skip: false, node: current };
			}
			if (ts.isStatement(current)) return { skip: false, node: current };
		}
		return { skip: false, node };
	}

	private isTopLevelVariable(decl: TS.VariableDeclaration): boolean {
		const container = decl.parent?.parent?.parent;
		return !!container && (this.ts.isSourceFile(container) || this.ts.isModuleBlock(container));
	}

	/** `const X = () => …`, or a call wrapping a function such as `forwardRef(…)` and `memo(…)`. */
	private isFunctionValue(node: TS.Expression | undefined): boolean {
		const ts = this.ts;
		if (!node) return false;
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
		return ts.isCallExpression(node) && node.arguments.some((arg) => this.isFunctionValue(arg));
	}

	/** Name of the class, or of the variable holding the object literal, that a member belongs to. */
	private ownerName(node: TS.Node): string | undefined {
		const ts = this.ts;
		if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) return node.name.text;
		if (ts.isObjectLiteralExpression(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
		return undefined;
	}

	/**
	 * The named function, method, class or top-level variable a reference is
	 * in, and the node to find its own references from. Anonymous functions
	 * are looked through: a call inside `items.map(i => …)` counts for the
	 * function around it.
	 */
	private callerOf(node: TS.Node): { name: string; kind: string; nameNode: TS.Node } | undefined {
		const ts = this.ts;
		for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
			if (ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) {
				const kind = ts.isClassDeclaration(current) ? "class" : "function";
				if (current.name) return { name: current.name.text, kind, nameNode: current.name };
				const keyword = current.modifiers?.find((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
				if (keyword) return { name: path.basename(current.getSourceFile().fileName).replace(/\.[cm]?[jt]sx?$/, ""), kind, nameNode: keyword };
				continue;
			}
			if (ts.isConstructorDeclaration(current)) {
				const owner = current.parent;
				if (ts.isClassLike(owner) && owner.name) return { name: `${owner.name.text}.constructor`, kind: "constructor", nameNode: owner.name };
				continue;
			}
			if (ts.isMethodDeclaration(current) || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current) || ts.isPropertyDeclaration(current)) {
				const memberName = current.name;
				if (!ts.isIdentifier(memberName) && !ts.isPrivateIdentifier(memberName) && !ts.isStringLiteral(memberName)) continue;
				const owner = this.ownerName(current.parent);
				return { name: owner ? `${owner}.${memberName.text}` : memberName.text, kind: ts.isPropertyDeclaration(current) ? "property" : "method", nameNode: memberName };
			}
			if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && this.isTopLevelVariable(current)) {
				return { name: current.name.text, kind: this.isFunctionValue(current.initializer) ? "function" : "variable", nameNode: current.name };
			}
		}
		return undefined;
	}

	/** Usages of the declaration whose name is at `pos` in `file`, in project files. */
	private sitesAt(program: TS.Program, file: string, pos: number): UsageSite<{ file: string; pos: number }>[] {
		const seen = new Set<string>();
		const sites: UsageSite<{ file: string; pos: number }>[] = [];
		for (const group of this.service.findReferences(file, pos) ?? []) {
			for (const ref of group.references) {
				if (ref.isDefinition || !this.isProjectFile(ref.fileName)) continue;
				const sf = program.getSourceFile(ref.fileName);
				if (!sf) continue;
				const node = this.nodeAt(sf, ref.textSpan.start);
				if (!node) continue;
				const context = this.usageContext(sf, node);
				if (context.skip) continue;
				const { line } = sf.getLineAndCharacterOfPosition(ref.textSpan.start);
				const location = `${relativeTo(this.config.root, sf.fileName)}:${line + 1}`;
				if (seen.has(location)) continue;
				seen.add(location);
				const usage: Usage = { location, text: trimBlock(context.node.getText(sf)) };
				const caller = this.callerOf(node);
				if (!caller) {
					sites.push({ usage });
					continue;
				}
				usage.in = { name: caller.name, kind: caller.kind };
				const handle = { file: sf.fileName, pos: caller.nameNode.getStart(sf) };
				sites.push({ usage, caller: { key: `${handle.file}:${handle.pos}`, handle } });
			}
		}
		return sites.sort((a, b) => a.usage.location.localeCompare(b.usage.location, undefined, { numeric: true }));
	}

	async usages(name: string, options: UsagesOptions): Promise<UsagesResult | null> {
		if (options.from && !this.accepts(options.from)) return null;
		const notes: string[] = [];
		const { program, found } = this.findSymbols(name, options.from, notes);
		const resolution: Resolution = { engine: this.engine, status: notes.length ? "partial" : "full", notes, info: [...this.compilerNotes] };
		if (!found.length) return { query: name, language: "typescript", total: 0, usages: [], resolution };

		const expanded = new Set<string>();
		const byLocation = new Map<string, UsageSite<{ file: string; pos: number }>>();
		for (const item of found) {
			const symbol = item.symbol.flags & this.ts.SymbolFlags.Alias ? program.getTypeChecker().getAliasedSymbol(item.symbol) : item.symbol;
			const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
			if (!decl) continue;
			const nameNode = this.ts.getNameOfDeclaration(decl as TS.Declaration) ?? decl;
			const file = decl.getSourceFile().fileName;
			expanded.add(`${file}:${nameNode.getStart()}`);
			for (const site of this.sitesAt(program, file, nameNode.getStart())) {
				if (!byLocation.has(site.usage.location)) byLocation.set(site.usage.location, site);
			}
		}
		const sites = [...byLocation.values()].sort((a, b) => a.usage.location.localeCompare(b.usage.location, undefined, { numeric: true }));
		const top = sites.slice(0, options.limit);
		expandCallers(top, options.depth, options.limit, (handle) => this.sitesAt(program, handle.file, handle.pos), expanded);
		return { query: name, language: "typescript", total: sites.length, usages: top.map((site) => site.usage), resolution };
	}

	async status(): Promise<AdapterStatus> {
		return {
			language: "typescript",
			engine: this.engine,
			files: this.setup.files.length,
			notes: [
				...this.compilerNotes,
				...this.setup.notes,
				this.setup.configFile ? `Using ${relativeTo(this.config.root, this.setup.configFile)}.` : "",
				...this.missingPackagesNotes(),
			].filter(Boolean),
		};
	}
}
