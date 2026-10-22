// Talk to the server over stdio the way an MCP client does.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../dist/cli.js");

const cleanEnv = () => {
	const env = { ...process.env };
	delete env.SYMBOL_MCP_ROOT;
	delete env.SYMBOL_MCP_INCLUDE;
	delete env.SYMBOL_MCP_EXCLUDE;
	return env;
};

test("MCP server takes its root from the client's roots when nothing else sets it", async () => {
	const project = path.join(here, "fixtures", "php-plain");
	const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: cleanEnv(), cwd: os.tmpdir() });
	const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: { roots: { listChanged: true } } });
	client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(project).href, name: "fixture" }] }));
	await client.connect(transport);
	try {
		const status = await client.callTool({ name: "status", arguments: { format: "json" } });
		const parsed = JSON.parse(status.content[0].text);
		assert.equal(parsed.root, project);
		assert.equal(parsed.rootSource, "MCP client roots");
		const describe = await client.callTool({ name: "describe", arguments: { name: "fixture_button" } });
		assert.match(describe.content[0].text, /variant: string = 'primary'/);
	} finally {
		await client.close();
	}
});

test("MCP server without client roots detects the project above its working directory", async () => {
	const project = path.join(here, "fixtures", "php-plain");
	const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: cleanEnv(), cwd: path.join(project, "src") });
	const client = new Client({ name: "test", version: "0.0.0" });
	await client.connect(transport);
	try {
		const parsed = JSON.parse((await client.callTool({ name: "status", arguments: { format: "json" } })).content[0].text);
		assert.equal(parsed.root, project);
		assert.match(parsed.rootSource, /nearest project folder/);
	} finally {
		await client.close();
	}
});

test("MCP server lists its tools and answers describe, list_exports, find_usages and status", async () => {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [cli, "mcp"],
		env: { ...process.env, SYMBOL_MCP_ROOT: path.join(here, "fixtures", "php-plain") },
	});
	const client = new Client({ name: "test", version: "0.0.0" });
	await client.connect(transport);
	try {
		const { tools } = await client.listTools();
		assert.deepEqual(tools.map((t) => t.name).sort(), ["describe", "find_usages", "list_exports", "status"]);

		const describe = await client.callTool({ name: "describe", arguments: { name: "fixture_button" } });
		assert.match(describe.content[0].text, /variant: string = 'primary'/);

		// A call's root replaces the server's default root.
		const other = await client.callTool({ name: "describe", arguments: { name: "formatPrice", root: path.join(here, "fixtures", "js-plain"), format: "json" } });
		assert.equal(JSON.parse(other.content[0].text).matches[0].name, "formatPrice");

		const exportsResult = await client.callTool({ name: "list_exports", arguments: { target: "src/Card.php" } });
		assert.match(exportsResult.content[0].text, /Fixture\\Card \(class\)/);

		const usages = await client.callTool({ name: "find_usages", arguments: { name: "Card::render" } });
		assert.match(usages.content[0].text, /functions\.php:19/);

		const status = await client.callTool({ name: "status", arguments: {} });
		assert.match(status.content[0].text, /PHP doesn't need to be installed/);

		const bad = await client.callTool({ name: "describe", arguments: { name: "x", language: "cobol" } });
		assert.equal(bad.isError, true);
	} finally {
		await client.close();
	}
});
