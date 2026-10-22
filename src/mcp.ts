import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveConfig, type ConfigInput } from "./config.js";
import { formatDescribe, formatExports, formatStatus, formatUsages } from "./format.js";
import { LANGUAGES, getWorkspace } from "./workspace.js";

const VERSION = "0.1.0";

const common = {
	root: z
		.string()
		.optional()
		.describe(
			"Project root for this call. Usually leave it out: the server uses --root or SYMBOL_MCP_ROOT, then the client's workspace root, then the nearest project folder above its working directory.",
		),
	format: z.enum(["text", "json"]).optional().describe("text (default) is compact and readable; json returns the full structure."),
};

const language = z
	.string()
	.optional()
	.describe(`Only look in one language: ${LANGUAGES.join(", ")}. JavaScript and TypeScript share one adapter.`);

function reply(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function failure(error: unknown) {
	return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
}

/**
 * Start the MCP server on stdio. `base` holds the environment and CLI
 * settings; a tool call's `root` replaces only the root.
 */
export async function startServer(base: ConfigInput[]): Promise<void> {
	const server = new McpServer({ name: "symbol-mcp", version: VERSION });

	// Workspace roots the client reports (roots/list). They rank below
	// SYMBOL_MCP_ROOT and --root, and above detection from the working directory.
	let clientRoots: string[] = [];
	let rootsReady: Promise<void> = Promise.resolve();
	const loadRoots = () => {
		if (!server.server.getClientCapabilities()?.roots) return Promise.resolve();
		return server.server
			.listRoots()
			.then(({ roots }) => {
				clientRoots = roots.filter((r) => r.uri.startsWith("file://")).map((r) => fileURLToPath(r.uri));
			})
			.catch(() => {
				// A client that advertises roots but fails to list them leaves detection in charge.
			});
	};
	server.server.oninitialized = () => {
		rootsReady = loadRoots();
	};
	server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
		rootsReady = loadRoots();
	});

	const configFor = async (root?: string) => {
		await rootsReady;
		const fromClient: ConfigInput = { root: clientRoots[0], source: `MCP client roots${clientRoots.length > 1 ? ` (first of ${clientRoots.length}: ${clientRoots.join(", ")})` : ""}` };
		return resolveConfig(fromClient, ...base, { root, source: "the tool call's root argument" });
	};
	const workspaceFor = async (root?: string) => getWorkspace(await configFor(root));

	server.registerTool(
		"describe",
		{
			title: "Describe a symbol",
			description:
				"Look up how to call a function, component, class, method, interface, type or constant, the way an editor's hover and autocomplete would. " +
				"Returns the signature, every parameter or prop with its resolved type, whether it's optional, its default value and its docblock, plus the file and line. " +
				"Works for code in the project and in installed packages (node_modules, Composer vendor), and reads PHP template files that document the variables they receive. " +
				"Use it before calling something you haven't used yet, instead of opening its source or .d.ts file.",
			inputSchema: {
				name: z
					.string()
					.describe('Symbol name, e.g. "Button", "useThing", "format_price", "Cart::addItem", "Client.request", "Vendor\\\\Pkg\\\\Client", or a PHP template file name without .php.'),
				from: z
					.string()
					.optional()
					.describe('Narrow the lookup: a file path relative to the root, a module specifier ("@scope/pkg", "./lib/api"), or a PHP namespace.'),
				language,
				depth: z
					.number()
					.int()
					.min(0)
					.max(10)
					.optional()
					.describe(
						"How many hops of custom types to define in the types: section (default: all, within a size budget). 1 defines the types parameters use directly, 2 also the types their fields use. 0 shows parameter types only, with no fields or types: section.",
					),
				...common,
			},
		},
		async (args) => {
			try {
				const result = await (await workspaceFor(args.root)).describe(args);
				return reply(args.format === "json" ? JSON.stringify(result, null, 2) : formatDescribe(result));
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"list_exports",
		{
			title: "List exports",
			description:
				"List what a module, package, file or PHP namespace provides: each export's name, kind, short signature and one-line summary. " +
				'Use it to see what a package such as "@scope/components" offers before picking something to describe.',
			inputSchema: {
				target: z.string().describe('A module specifier ("@scope/pkg", "./lib/api"), a file path relative to the root, or a PHP namespace ("Vendor\\\\Pkg").'),
				language,
				...common,
			},
		},
		async (args) => {
			try {
				const { results, notes } = await (await workspaceFor(args.root)).exports(args);
				return reply(args.format === "json" ? JSON.stringify({ results, notes }, null, 2) : formatExports(results, notes));
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"find_usages",
		{
			title: "Find usages",
			description:
				"Show where the project calls or renders a symbol, with the full call or JSX element at each place, so you can copy a working example. " +
				"Project files come first; dependencies are searched only when the project has no usages.",
			inputSchema: {
				name: z.string().describe("Symbol name, as for describe."),
				from: z.string().optional().describe("Narrow which symbol is meant, as for describe."),
				language,
				limit: z.number().int().min(1).max(200).optional().describe("Most usages to return (default 10)."),
				...common,
			},
		},
		async (args) => {
			try {
				const { results, notes } = await (await workspaceFor(args.root)).usages(args);
				return reply(args.format === "json" ? JSON.stringify({ results, notes }, null, 2) : formatUsages(results, notes));
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"status",
		{
			title: "Index status",
			description:
				"Show the project root, which engines are used (project or bundled TypeScript, the PHP parser), how many files are indexed, and what's missing, such as node_modules, vendor/ or a tsconfig.",
			inputSchema: { ...common },
		},
		async (args) => {
			try {
				const config = await configFor(args.root);
				const status = await getWorkspace(config).status(config.rootSource);
				return reply(args.format === "json" ? JSON.stringify(status, null, 2) : formatStatus(status));
			} catch (error) {
				return failure(error);
			}
		},
	);

	await server.connect(new StdioServerTransport());
}
