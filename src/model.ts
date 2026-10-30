/**
 * Result shapes shared by every language adapter, the MCP server and the CLI.
 */

/** How completely a result was resolved, and by what. */
export interface Resolution {
	/** Engine that produced the result, e.g. "typescript 5.9.3 (project)" or "tree-sitter-php". */
	engine: string;
	/** "full" when every type in the result resolved; "partial" when something is missing (see notes). */
	status: "full" | "partial";
	/** What the reader should know to use the result: why it's partial, or a limit of the answer. Shown in text output. */
	notes: string[];
	/** Background, such as which compiler or config was used. JSON output only; `status` reports the same. */
	info?: string[];
}

/** A parameter, prop, array-shape key or object property. */
export interface Field {
	name: string;
	type?: string;
	optional?: boolean;
	/** Default value as source text, when the code or docblock declares one. */
	default?: string;
	doc?: string;
	/** file:line where the field is declared, when it differs from the symbol's own file. */
	declaredIn?: string;
	/** Nested fields of an unnamed object-typed field (keys of an inline array shape or hash-notation array). Named types go in SymbolInfo.types instead. */
	fields?: Field[];
	/** Fields left out of `fields` because they come from a large inherited type, grouped by origin. */
	inherited?: { from: string; count: number }[];
}

export interface Signature {
	text: string;
	params: Field[];
	returns?: { type?: string; doc?: string };
}

/** Short entry for a class member or a module export. */
export interface MemberSummary {
	name: string;
	kind: string;
	signature?: string;
	summary?: string;
	location?: string;
}

export interface SymbolInfo {
	name: string;
	qualifiedName?: string;
	kind: string;
	language: string;
	/** Relative path and 1-based line. */
	location: string;
	/** Where docblocks and defaults were recovered from, when it isn't `location` (source maps, package sources). */
	source?: string;
	/** Module specifier project code imports the symbol from. */
	importFrom?: string;
	/** Declared in an installed package (node_modules, Composer vendor) rather than the project. */
	dependency?: boolean;
	doc?: string;
	tags?: { name: string; text: string }[];
	signatures?: Signature[];
	/** Properties of an interface, type alias, shape or object constant. */
	fields?: Field[];
	inherited?: { from: string; count: number }[];
	members?: MemberSummary[];
	/** Declared type of a variable, constant or property. */
	type?: string;
	/**
	 * Custom types the answer refers to by name, each defined once, in the
	 * order they're first referenced. Types from the standard library and
	 * @types packages aren't listed.
	 */
	types?: TypeEntry[];
	/** Referenced types left out because of `depth` or the size budget. Describe them for their fields. */
	typesOmitted?: string[];
	resolution: Resolution;
}

export interface TypeEntry {
	/** As written where it's referenced, e.g. "ImageProps" or "Response<User>". */
	name: string;
	/** For an alias of a non-object type (a union, a PHP array shape): what it stands for. */
	definition?: string;
	/** For an object type: its properties. */
	fields?: Field[];
	inherited?: { from: string; count: number }[];
	/** First line of the type's docblock. */
	doc?: string;
	/** Hops from the signature: 1 for a type a parameter uses, 2 for a type one of its fields uses. */
	level: number;
}

export interface DeclarationRef {
	name: string;
	kind: string;
	language: string;
	location: string;
}

export interface DescribeResult {
	query: string;
	matches: SymbolInfo[];
	/** Declarations with the same name in languages the query filtered out. */
	alsoDefinedIn: DeclarationRef[];
	notes: string[];
}

export interface ExportsResult {
	target: string;
	language: string;
	location?: string;
	exports: MemberSummary[];
	resolution: Resolution;
}

export interface Usage {
	location: string;
	/** The call, JSX element or expression that uses the symbol, trimmed to a few lines. Left out below the first level of a caller tree. */
	text?: string;
	/** The function, method, class or template file the usage is in. */
	in?: { name: string; kind: string };
	/** The symbol is passed by name (a PHP callable string or array) for other code to call later, so the callers of `in` aren't followed. */
	callback?: boolean;
	/** Only the name matched: the class of the object it's called on couldn't be worked out. Its callers aren't followed. */
	unconfirmed?: boolean;
	/** Usages of `in`, when `depth` is more than 1. */
	callers?: Usage[];
	/** Usages of `in` left out by `limit` or the size budget. */
	moreCallers?: number;
	/** `in` is the symbol itself, or its callers are listed under another usage. */
	repeated?: boolean;
}

export interface UsagesResult {
	query: string;
	language: string;
	total: number;
	usages: Usage[];
	resolution: Resolution;
}

export interface AdapterStatus {
	language: string;
	engine: string;
	files: number;
	notes: string[];
}

export interface DescribeOptions {
	from?: string;
	/** How many levels of object-typed fields to expand. */
	depth: number;
}

export interface UsagesOptions {
	from?: string;
	limit: number;
	/** Levels of the caller tree: 1 lists the usages only, 2 also the usages of the functions they're in. */
	depth: number;
}

export interface LanguageAdapter {
	readonly language: string;
	/** Re-read the file list and config and re-parse changed files. Called once at the start of every request. */
	sync(): Promise<void>;
	/** Whether this adapter should answer for a `from` value (file path or module specifier). */
	accepts(from: string): boolean;
	describe(name: string, options: DescribeOptions): Promise<SymbolInfo[]>;
	/** Cheap lookup of project declarations by name, used for "also defined in". */
	declarations(name: string): Promise<DeclarationRef[]>;
	/** Returns null when the target isn't something this adapter understands. */
	exports(target: string): Promise<ExportsResult | null>;
	usages(name: string, options: UsagesOptions): Promise<UsagesResult | null>;
	status(): Promise<AdapterStatus>;
}
