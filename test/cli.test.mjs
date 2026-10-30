// End-to-end tests: run the built CLI against the fixture projects.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../dist/cli.js");
const fixture = (name) => path.join(here, "fixtures", name);

// The fixture's installed packages are kept outside node_modules so they aren't committed,
// and copied into place only while the tests run.
const fixturePackages = path.join(here, "fixture-packages", "ts-new-compiler");
const fixtureNodeModules = path.join(fixture("ts-new-compiler"), "node_modules");
before(() => {
	fs.rmSync(fixtureNodeModules, { recursive: true, force: true });
	fs.cpSync(fixturePackages, fixtureNodeModules, { recursive: true });
});
after(() => fs.rmSync(fixtureNodeModules, { recursive: true, force: true }));

function run(args, env = {}) {
	const result = spawnSync(process.execPath, [cli, ...args, "--json"], {
		encoding: "utf8",
		env: { ...process.env, SYMBOL_MCP_ROOT: "", SYMBOL_MCP_INCLUDE: "", SYMBOL_MCP_EXCLUDE: "", ...env },
	});
	return { code: result.status, json: result.stdout ? JSON.parse(result.stdout) : null, stderr: result.stderr };
}

const field = (fields, name) => fields?.find((f) => f.name === name);

test("JavaScript without tsconfig: JSDoc types, destructured defaults, missing node_modules", () => {
	const { code, json } = run(["describe", "formatPrice", "--root", fixture("js-plain")]);
	assert.equal(code, 0);
	const [match] = json.matches;
	const [sig] = match.signatures;
	assert.equal(field(sig.params, "amount").type, "number");
	const options = sig.params[1];
	assert.equal(options.name, "{ currency = \"USD\", showSymbol = true }");
	assert.equal(field(options.fields, "currency").default, '"USD"');
	assert.equal(match.resolution.status, "partial");
	assert.ok(match.resolution.info.some((n) => n.includes("No tsconfig.json")));
	assert.ok(match.resolution.notes.some((n) => n.includes("left-pad")));
	assert.ok(match.resolution.notes.some((n) => n.includes("node_modules doesn't exist")));
});

test("project without any TypeScript falls back to the bundled compiler", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symbol-mcp-js-"));
	fs.cpSync(fixture("js-plain"), dir, { recursive: true });
	try {
		const { json } = run(["describe", "formatPrice", "--root", dir]);
		assert.match(json.matches[0].resolution.engine, /\(bundled\)$/);
		assert.ok(json.matches[0].resolution.info.some((n) => n.includes("has no TypeScript installed")));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("project TypeScript without the compiler API (TypeScript 7) falls back to the bundled compiler", () => {
	const { json } = run(["describe", "Card", "--root", fixture("ts-new-compiler"), "--language", "ts"]);
	const [match] = json.matches;
	assert.equal(match.kind, "component");
	assert.match(match.resolution.engine, /\(bundled\)$/);
	assert.ok(match.resolution.info.some((n) => n.includes("7.0.2")));
	const props = match.signatures[0].params[0];
	assert.equal(props.name, "props");
	assert.equal(field(props.fields, "tone").default, '"light"');
	assert.equal(field(props.fields, "className").doc, "Extra classes on the wrapper.");
	assert.equal(field(props.fields, "id"), undefined, "Omit<> removed id");
	assert.equal(field(props.fields, "title").optional, undefined);
});

const entry = (types, name) => types?.find((t) => t.name === name);

test("custom types a component's props use are defined once under types:", () => {
	const { json } = run(["describe", "Card", "--root", fixture("ts-new-compiler"), "--language", "ts"]);
	const [match] = json.matches;
	const props = match.signatures[0].params[0];
	assert.equal(field(props.fields, "image").type, "string | number | ImageRef");
	assert.equal(field(props.fields, "image").fields, undefined, "fields go in types:, not under the prop");
	assert.deepEqual(entry(match.types, "ImageRef").fields.map((f) => f.name), ["id", "alt"]);
	assert.equal(field(entry(match.types, "ImageRef").fields, "alt").doc, "Alternative text.");
	assert.deepEqual(entry(match.types, "LinkRef").fields.map((f) => f.name), ["href", "label"]);
	assert.equal(entry(match.types, "CardProps"), undefined, "the props type itself is listed above, not again");
});

test("types: rules: generics once, recursion, array elements, tuple aliases, interfaces that only extend", () => {
	const { json } = run(["describe", "build", "--root", fixture("ts-new-compiler"), "--language", "ts"]);
	const { types } = json.matches[0];
	assert.deepEqual(types.map((t) => t.name).sort(), ["Box<T>", "Item", "ItemList", "Pair", "TreeNode"]);
	assert.equal(entry(types, "Box<T>").fields[0].type, "T");
	assert.equal(entry(types, "Pair").definition, "readonly [string, Item?]");
	assert.equal(entry(types, "ItemList").definition, "readonly Item[]");
	assert.equal(field(entry(types, "TreeNode").fields, "children").type, "TreeNode[]");
	const depthOne = run(["describe", "build", "--root", fixture("ts-new-compiler"), "--language", "ts", "--depth", "1"]).json.matches[0];
	assert.ok(depthOne.types.every((t) => t.level === 1));
});

test("a component's return type isn't defined under types:, a function's is", () => {
	const component = run(["describe", "Panel", "--root", fixture("ts-new-compiler"), "--language", "ts"]).json.matches[0];
	assert.equal(component.kind, "component");
	assert.equal(entry(component.types, "PanelElement"), undefined);
	const fn = run(["describe", "loadPanel", "--root", fixture("ts-new-compiler"), "--language", "ts"]).json.matches[0];
	assert.deepEqual(entry(fn.types, "PanelResult").fields.map((f) => f.name), ["ok"]);
});

test("a named member of inlined intersection props isn't defined again under types:", () => {
	const match = run(["describe", "Toolbar", "--root", fixture("ts-new-compiler"), "--language", "ts"]).json.matches[0];
	assert.deepEqual(match.signatures[0].params[0].fields.map((f) => f.name), ["label", "onChange", "extra"]);
	assert.equal(entry(match.types, "ToolbarProps"), undefined);
});

test("React's types aren't defined; props from a base type are summarized under its name", () => {
	const match = run(["describe", "Chip", "--root", fixture("ts-new-compiler"), "--language", "ts"]).json.matches[0];
	const props = match.signatures[0].params[0];
	assert.deepEqual(props.fields.map((f) => f.name), ["label", "icon"]);
	assert.deepEqual(props.inherited, [{ from: "HTMLAttributes<HTMLDivElement>", count: 3 }]);
	assert.equal(match.types, undefined, "ReactNode's parts (ReactElement) aren't listed");
});

function runText(args) {
	return spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf8",
		env: { ...process.env, SYMBOL_MCP_ROOT: "", SYMBOL_MCP_INCLUDE: "", SYMBOL_MCP_EXCLUDE: "" },
	}).stdout;
}

test("text output summarizes inherited props only when the parameter's type doesn't name their source", () => {
	const root = fixture("ts-new-compiler");
	const chip = runText(["describe", "Chip", "--root", root, "--language", "ts"]);
	assert.match(chip, /\+ 3 more from HTMLAttributes<HTMLDivElement>/, "a base type that ChipProps extends isn't in the signature");
	const tag = run(["describe", "Tag", "--root", root, "--language", "ts"]).json.matches[0];
	assert.deepEqual(tag.signatures[0].params[0].inherited, [{ from: "HTMLAttributes<HTMLSpanElement>", count: 3 }], "JSON keeps the group");
	const tagText = runText(["describe", "Tag", "--root", root, "--language", "ts"]);
	assert.match(tagText, /props: TagProps & HTMLAttributes<HTMLSpanElement>/);
	assert.doesNotMatch(tagText, /more from/);
});

test("an anonymous default export is found by its file name", () => {
	const { code, json } = run(["describe", "Widget", "--root", fixture("ts-new-compiler"), "--language", "ts"]);
	assert.equal(code, 0);
	const [match] = json.matches;
	assert.equal(match.name, "Widget");
	assert.equal(match.kind, "component");
	assert.match(match.signatures[0].text, /^Widget\(/);
	assert.equal(field(match.signatures[0].params[0].fields, "size").default, '"md"');
});

test("text output for a package symbol: import path instead of file locations; JSON keeps them", () => {
	const args = ["describe", "Badge", "--root", fixture("ts-new-compiler"), "--language", "ts"];
	const text = execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" });
	assert.match(text, /import from: "@acme\/ui"/);
	assert.doesNotMatch(text, /^at: /m);
	assert.doesNotMatch(text, /node_modules/);
	assert.match(text, /label: string/);
	const { json } = run(args);
	const [match] = json.matches;
	assert.equal(match.dependency, true);
	assert.match(match.location, /node_modules\/@acme\/ui\/index\.d\.ts:5$/);
	assert.match(field(match.signatures[0].params[0].fields, "label").declaredIn, /base\.d\.ts:2$/);
});

test("text output: no resolution block when fully resolved; types: one line without docs, a list with them", () => {
	const text = execFileSync(process.execPath, [cli, "describe", "Card", "--root", fixture("ts-new-compiler"), "--language", "ts"], { encoding: "utf8" });
	assert.doesNotMatch(text, /resolution:/);
	assert.doesNotMatch(text, /typescript 5\./);
	assert.match(text, /\ntypes:\n  ImageRef\n      id: number \| null\n      alt\?: string  \/\/ Alternative text\.\n  LinkRef \{ href: string; label\?: string \}/);
	const partial = execFileSync(process.execPath, [cli, "describe", "formatPrice", "--root", fixture("js-plain")], { encoding: "utf8" });
	assert.match(partial, /resolution: partial\n  - Imports that didn't resolve/);
});

test("PHP without vendor/ and without php on PATH", () => {
	const nodeOnly = path.dirname(process.execPath);
	const { code, json } = run(["describe", "Card::render", "--root", fixture("php-plain"), "--depth", "2"], { PATH: nodeOnly });
	assert.equal(code, 0);
	const [match] = json.matches;
	assert.equal(match.qualifiedName, "Fixture\\Card::render");
	const [card, args] = match.signatures[0].params;
	assert.equal(card.type, "CardData");
	assert.equal(entry(match.types, "CardData").definition, "array{title: string, tone?: 'light'|'dark', tags?: list<string>}");
	assert.equal(field(args.fields, "className").default, "''");
	assert.equal(field(args.fields, "echo").default, "true");
	assert.equal(field(args.fields, "level").default, "2");
	assert.equal(match.resolution.status, "partial");
	assert.ok(match.resolution.notes.some((n) => n.includes("Acme\\Links\\Link")));
	assert.ok(match.resolution.info.some((n) => n.includes("composer install")));
});

test("depth 0 shows parameter types without fields in both languages", () => {
	const php = run(["describe", "Card::render", "--root", fixture("php-plain"), "--depth", "0"]).json.matches[0];
	assert.ok(php.signatures[0].params.every((p) => p.fields === undefined));
	const notice = run(["describe", "notice", "--root", fixture("php-plain"), "--depth", "0"]).json.matches[0];
	assert.ok(notice.signatures[0].params.every((p) => p.fields === undefined));
	const ts = run(["describe", "Card", "--root", fixture("ts-new-compiler"), "--language", "ts", "--depth", "0"]).json.matches[0];
	assert.equal(ts.signatures[0].params[0].fields, undefined);
});

test("PHP template file and guarded function", () => {
	const notice = run(["describe", "notice", "--root", fixture("php-plain")]).json.matches[0];
	assert.equal(notice.kind, "template file");
	const args = notice.signatures[0].params[0];
	assert.equal(field(args.fields, "type").default, "'info'");
	assert.equal(field(args.fields, "dismissible").default, "false");

	const button = run(["describe", "fixture_button", "--root", fixture("php-plain")]).json.matches[0];
	assert.equal(button.doc, "Print a button.");
	const options = button.signatures[0].params[1];
	assert.equal(field(options.fields, "variant").default, "'primary'");
	assert.equal(field(options.fields, "size").default, "'md'");
});

test("usages show the call with its arguments", () => {
	const php = run(["usages", "fixture_button", "--root", fixture("php-plain")]).json.results[0];
	assert.equal(php.total, 1);
	assert.match(php.usages[0].text, /fixture_button\( 'Go'/);

	const exportOnly = run(["usages", "Card", "--root", fixture("ts-new-compiler"), "--language", "ts"]);
	assert.equal(exportOnly.code, 1, "export default Card isn't a usage");

	const js = run(["usages", "formatPrice", "--root", fixture("js-plain")]).json.results[0];
	assert.equal(js.total, 1);
	assert.match(js.usages[0].location, /^src\/cart\.js:4$/);
	assert.match(js.usages[0].text, /currency: "EUR"/);
});

const usagesOf = (name, root, extra = []) => run(["usages", name, "--root", fixture(root), ...extra]).json.results.flatMap((r) => r.usages);
const byLocation = (usages) => Object.fromEntries(usages.map((u) => [u.location, u]));

test("PHP usages: receiver classes, use aliases, traits and callbacks", () => {
	const render = byLocation(usagesOf("Cart::render", "php-usages"));
	assert.deepEqual(Object.keys(render).sort(), ["functions.php:7", "src/Cart.php:27", "src/Report.php:13", "src/Report.php:14"]);
	assert.equal(render["src/Cart.php:27"].callback, true, "[ $this, 'render' ] is a callback");
	assert.equal(render["src/Report.php:14"].unconfirmed, true, "$unknown has no type");
	assert.equal(render["functions.php:7"].unconfirmed, undefined, "$cart = new Cart()");
	assert.deepEqual(render["src/Report.php:13"].in, { name: "Report::build", kind: "method" });

	const report = byLocation(usagesOf("Report::render", "php-usages"));
	assert.deepEqual(Object.keys(report).sort(), ["src/Report.php:12", "src/Report.php:14"], "$cart->render() is Cart's");

	assert.deepEqual(Object.keys(byLocation(usagesOf("Formatter::format", "php-usages"))), ["src/Cart.php:23"], "typed property through a use alias");
	assert.deepEqual(Object.keys(byLocation(usagesOf("Totals::total", "php-usages"))), ["src/Cart.php:23"], "trait method through $this");
	assert.deepEqual(Object.keys(byLocation(usagesOf("Cart", "php-usages"))).sort(), ["functions.php:6", "src/Report.php:10"], "$cart isn't the class");

	const setup = byLocation(usagesOf("setup", "php-usages"));
	assert.deepEqual(Object.keys(setup).sort(), ["functions.php:11", "functions.php:14", "functions.php:20"]);
	assert.equal(setup["functions.php:14"].callback, true);
	assert.equal(setup["functions.php:14"].unconfirmed, undefined, "add_action's $callback is declared callable");

	const filter = usagesOf("Cart::filter", "php-usages");
	assert.equal(filter.length, 1);
	assert.equal(filter[0].callback, true, "[ self::class, 'filter' ] passed to an undeclared function");
});

test("JSON and YAML paths that resolve to a template file are usages of it", () => {
	const notice = usagesOf("Notice", "php-usages");
	assert.deepEqual(
		notice.map((u) => `${u.location} ${u.text}`),
		["blocks/Notice/block.json:4 \"render\": \"file:./Notice.php\"", "config/views.yml:2 template: blocks/Notice/Notice.php", "config/views.yml:4 - blocks/Notice/Notice.php"],
		"blocks/Other/block.json points at blocks/Other/Notice.php, and .tooling/ is hidden",
	);
	const [inTemplate] = usagesOf("notice_classes", "php-usages", ["--depth", "2"]);
	assert.deepEqual(inTemplate.in, { name: "blocks/Notice/Notice.php", kind: "template file" });
	assert.deepEqual(inTemplate.callers.map((u) => u.location), ["blocks/Notice/block.json:4", "config/views.yml:2", "config/views.yml:4"]);
});

test("caller trees follow the functions usages are in", () => {
	const [format] = usagesOf("Formatter::format", "php-usages", ["--depth", "3"]);
	assert.deepEqual(format.in, { name: "Cart::render", kind: "method" });
	const callers = byLocation(format.callers);
	assert.equal(callers["functions.php:7"].text, undefined, "only the first level has code");
	assert.deepEqual(callers["functions.php:7"].callers.map((u) => `${u.location} ${u.in?.name}`), ["functions.php:11 boot", "functions.php:14 undefined", "functions.php:20 undefined"]);
	assert.equal(callers["src/Cart.php:27"].callers, undefined, "a callback's callers aren't followed");
	assert.equal(callers["src/Report.php:14"].callers, undefined, "an unconfirmed usage's callers aren't followed");
	assert.deepEqual(callers["src/Report.php:13"].callers, [], "nothing uses Report::build");

	const ts = byLocation(usagesOf("formatPrice", "ts-callers", ["--depth", "5"]));
	const chain = [];
	for (let usage = ts["src/cart.ts:4"]; usage; usage = usage.callers?.[0]) chain.push(`${usage.location} ${usage.in?.name ?? "-"}`);
	assert.deepEqual(chain, ["src/cart.ts:4 total", "src/checkout.ts:3 checkout", "src/checkout.ts:7 Page.render", "src/main.ts:3 -"]);
	assert.equal(ts["src/price.ts:2"].repeated, true, "a recursive call doesn't expand the symbol again");
	const badge = ts["src/Badge.ts:4"];
	assert.deepEqual([badge.in.name, badge.callers[0].location, badge.callers[0].in.name], ["Badge", "src/labels.ts:3", "saleLabel"], "an anonymous default export is followed by its file name");

	const text = spawnSync(process.execPath, [cli, "usages", "formatPrice", "--root", fixture("ts-callers"), "--depth", "3"], { encoding: "utf8" }).stdout;
	assert.match(text, /^src\/cart\.ts:4 {2}in total \(function\)\n {2}formatPrice\(item\)\n {2}← src\/checkout\.ts:3 {2}in checkout \(function\)\n {4}← src\/checkout\.ts:7 {2}in Page\.render \(method\)$/m);
});

test("PHP array defaults come from any merge assigned back or returned, whatever its name", () => {
	const configure = run(["describe", "configure", "--root", fixture("php-usages")]).json.matches[0];
	assert.deepEqual(configure.signatures[0].params[0].fields.map((f) => `${f.name}=${f.default}`), ["size='lg'"], "a merge into another variable doesn't count");
	const normalize = run(["describe", "normalize", "--root", fixture("php-usages")]).json.matches[0];
	assert.deepEqual(normalize.signatures[0].params[0].fields.map((f) => `${f.name}=${f.default}`), ["label=''"]);
});

test("exports of a file and a namespace", () => {
	const ts = run(["exports", "src/price.js", "--root", fixture("js-plain")]).json.results[0];
	assert.deepEqual(ts.exports.map((e) => e.name).sort(), ["formatPrice", "untyped"]);
	const php = run(["exports", "Fixture", "--root", fixture("php-plain"), "--language", "php"]);
	assert.equal(php.code, 1, "a bare word isn't a namespace target");
	const ns = run(["exports", "Fixture\\", "--root", fixture("php-plain")]).json.results.find((r) => r.language === "php");
	assert.deepEqual(ns.exports.map((e) => e.name), ["Fixture\\Card"]);
});

test("language filter lists the other language under alsoDefinedIn", () => {
	const { json } = run(["describe", "Card", "--root", fixture("php-plain"), "--language", "ts"]);
	assert.equal(json.matches.length, 0);
	assert.ok(json.alsoDefinedIn.some((ref) => ref.language === "php" && ref.name === "Fixture\\Card"));
});

test("environment variables and flags: SYMBOL_MCP_ROOT, --exclude replaces SYMBOL_MCP_EXCLUDE", () => {
	const viaEnv = run(["describe", "fixture_button"], { SYMBOL_MCP_ROOT: fixture("php-plain") });
	assert.equal(viaEnv.code, 0);
	const excludedByEnv = run(["describe", "fixture_button"], { SYMBOL_MCP_ROOT: fixture("php-plain"), SYMBOL_MCP_EXCLUDE: "functions.php" });
	assert.equal(excludedByEnv.code, 1);
	const flagReplacesEnv = run(["describe", "fixture_button", "--exclude", "templates/"], { SYMBOL_MCP_ROOT: fixture("php-plain"), SYMBOL_MCP_EXCLUDE: "functions.php" });
	assert.equal(flagReplacesEnv.code, 0);
});

test("SYMBOL_MCP_INCLUDE indexes a folder outside the root", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symbol-mcp-empty-"));
	try {
		const missing = run(["describe", "notice", "--root", dir]);
		assert.equal(missing.code, 1);
		const included = run(["describe", "notice", "--root", dir], { SYMBOL_MCP_INCLUDE: path.join(fixture("php-plain"), "templates") });
		assert.equal(included.code, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("help and errors", () => {
	const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
	assert.match(help, /SYMBOL_MCP_INCLUDE/);
	const bad = run(["describe", "x", "--language", "cobol", "--root", fixture("php-plain")]);
	assert.equal(bad.code, 2);
	assert.match(bad.stderr, /Unknown language/);
});
