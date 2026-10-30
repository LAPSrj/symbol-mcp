#!/usr/bin/env node
import { parseArgs } from "node:util";
import { configFromEnv, resolveConfig, splitList, type ConfigInput } from "./config.js";
import { formatDescribe, formatExports, formatStatus, formatUsages } from "./format.js";
import { startServer } from "./mcp.js";
import { getWorkspace } from "./workspace.js";

const HELP = `symbol-mcp: look up signatures, props, parameters, defaults and docblocks in a codebase.

Usage:
  symbol-mcp mcp                       Start the MCP server on stdio
  symbol-mcp describe <name>           Signature, parameters/props, defaults and docs of a symbol
  symbol-mcp exports <target>          What a module, package, file or PHP namespace provides
  symbol-mcp usages <name>             Where the project calls or renders a symbol
  symbol-mcp status                    Engines in use, indexed files and what's missing

Options:
  --root <dir>         Project root (default: SYMBOL_MCP_ROOT, then the nearest folder at or
                       above the current directory with .git, package.json, composer.json,
                       tsconfig.json or jsconfig.json)
  --include <paths>    Extra folders or files to index, comma-separated or repeated
                       (default: SYMBOL_MCP_INCLUDE)
  --exclude <globs>    Extra ignore patterns in .gitignore syntax, comma-separated or repeated
                       (default: SYMBOL_MCP_EXCLUDE)
  --from <spec>        describe/usages: file path, module specifier or PHP namespace to narrow the lookup
  --language <lang>    typescript, javascript or php
  --depth <n>          describe: hops of custom types to define under types: (0-10, default all)
                       usages: levels of callers to list (1-10, default 1)
  --limit <n>          usages: most results to show (default 10)
  --json               Print JSON instead of text
  -h, --help           Show this help

Flags replace the matching environment variable; they don't add to it.

Exit status: 0 when something was found, 1 when nothing matched, 2 on errors.`;

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			root: { type: "string" },
			include: { type: "string", multiple: true },
			exclude: { type: "string", multiple: true },
			from: { type: "string" },
			language: { type: "string" },
			depth: { type: "string" },
			limit: { type: "string" },
			json: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	const [command, target] = positionals;
	if (values.help || !command) {
		console.log(HELP);
		return command || values.help ? 0 : 2;
	}

	const flags: ConfigInput = {
		source: "--root",
		root: values.root,
		include: values.include?.flatMap((v) => splitList(v)),
		exclude: values.exclude?.flatMap((v) => splitList(v)),
	};
	const base = [configFromEnv(), flags];

	if (command === "mcp" || command === "serve") {
		await startServer(base);
		return -1;
	}

	const workspace = getWorkspace(resolveConfig(...base));
	const json = values.json === true;
	const number = (value: string | undefined, name: string): number | undefined => {
		if (value === undefined) return undefined;
		const parsed = Number.parseInt(value, 10);
		if (Number.isNaN(parsed)) throw new Error(`--${name} needs a number, got "${value}".`);
		return parsed;
	};
	const requireTarget = () => {
		if (!target) throw new Error(`${command} needs an argument. Run symbol-mcp --help.`);
		return target;
	};

	switch (command) {
		case "describe": {
			const result = await workspace.describe({ name: requireTarget(), from: values.from, language: values.language, depth: number(values.depth, "depth") });
			console.log(json ? JSON.stringify(result, null, 2) : formatDescribe(result));
			return result.matches.length ? 0 : 1;
		}
		case "exports": {
			const { results, notes } = await workspace.exports({ target: requireTarget(), language: values.language });
			console.log(json ? JSON.stringify({ results, notes }, null, 2) : formatExports(results, notes));
			return results.some((r) => r.exports.length) ? 0 : 1;
		}
		case "usages": {
			const { results, notes } = await workspace.usages({
				name: requireTarget(),
				from: values.from,
				language: values.language,
				limit: number(values.limit, "limit"),
				depth: number(values.depth, "depth"),
			});
			console.log(json ? JSON.stringify({ results, notes }, null, 2) : formatUsages(results, notes));
			return results.some((r) => r.total > 0) ? 0 : 1;
		}
		case "status": {
			const status = await workspace.status(resolveConfig(...base).rootSource);
			console.log(json ? JSON.stringify(status, null, 2) : formatStatus(status));
			return 0;
		}
		default:
			console.error(`Unknown command "${command}".\n\n${HELP}`);
			return 2;
	}
}

main().then(
	(code) => {
		if (code >= 0) process.exitCode = code;
	},
	(error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	},
);
