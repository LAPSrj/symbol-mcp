# symbol-mcp

Look up how to call things in a codebase the way an editor's hover and
autocomplete do: the signature, every parameter or prop with its resolved
type, whether it's optional, its default value and its docblock, plus where
it's declared. It works as an MCP server for agents and as a CLI.

Languages: TypeScript and JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`,
`.cjs`, `.mts`, `.cts`) and PHP.

## Install

```sh
npm install
npm run build
```

Node 20 or later is the only requirement. PHP doesn't need to be installed,
because PHP files are parsed with a WebAssembly build of tree-sitter-php.

## Use it as an MCP server

```json
{
  "mcpServers": {
    "symbol": {
      "command": "node",
      "args": ["/path/to/symbol-mcp/dist/cli.js", "mcp"],
      "env": { "SYMBOL_MCP_ROOT": "/path/to/project" }
    }
  }
}
```

You don't need to set `SYMBOL_MCP_ROOT`. The root comes from the first of
these that is set:

1. the `root` argument of a tool call
2. `--root`
3. `SYMBOL_MCP_ROOT`
4. the first workspace root the MCP client reports (`roots/list`), updated
   when the client says its roots changed
5. the nearest folder at or above the server's working directory that has
   `.git`, `package.json`, `composer.json`, `tsconfig.json` or `jsconfig.json`

The `status` tool shows which one was used.

Tools:

| Tool | What it returns |
|---|---|
| `describe` | Signature, parameters or props (expanded into fields), defaults, docblock, location. Takes `name`, and optionally `from`, `language`, `depth`, `root`, `format`. |
| `list_exports` | Everything a module, package, file or PHP namespace provides, with short signatures. |
| `find_usages` | Where the project calls or renders a symbol, with the whole call or JSX element. |
| `status` | Root, engines in use, indexed file counts, and what's missing. |

An answer that didn't fully resolve ends with `resolution: partial` and the
reasons (an import that didn't resolve, packages that aren't installed, a
type imported from a class that isn't indexed). A fully resolved answer has
no resolution block. The engine and background details, such as which
TypeScript was used, are in the `--json` / `format: "json"` output and in
`status`.

`llms-full.txt` is the manual for agents that call the tools: every argument,
name forms, lookup order, how to read the output, recipes and diagnosis.

## Use it as a CLI

```sh
symbol-mcp describe Button
symbol-mcp describe "Cart::addItem" --depth 1
symbol-mcp describe Button --from @acme/ui
symbol-mcp exports @acme/ui
symbol-mcp exports "Vendor\Package"
symbol-mcp usages formatPrice --limit 5
symbol-mcp status
```

Run it as `node dist/cli.js …`, or run `npm link` once to put `symbol-mcp` on
your PATH. Add `--json` for the full structure. Run `symbol-mcp --help` for
every flag.

## Configuration

| Environment variable | CLI flag | Meaning |
|---|---|---|
| `SYMBOL_MCP_ROOT` | `--root` | Project root. Default: the nearest project folder at or above the current directory (see above). |
| `SYMBOL_MCP_INCLUDE` | `--include` | Extra folders or files to index, comma- or newline-separated. They can be outside the root or ignored by `.gitignore`. |
| `SYMBOL_MCP_EXCLUDE` | `--exclude` | Extra ignore patterns in `.gitignore` syntax, on top of the project's `.gitignore` files. |

A flag replaces its environment variable instead of adding to it. Paths in
`--include` are relative to the root.

Everything else comes from the project itself:

- TypeScript and JavaScript use `tsconfig.json` or `jsconfig.json` in the root
  (including project references). Without one, every source file the
  `.gitignore` allows is loaded with default options (JavaScript allowed, JSX,
  bundler module resolution).
- PHP indexes the project's `.php` files (minus `.gitignore`d ones and the
  vendor folder), plus every path in Composer's autoload
  (`vendor/composer/installed.json`). When a name isn't found there, the
  vendor folder is searched by name, which finds packages Composer doesn't
  autoload, such as stub packages.

## How it fills in what's missing

| Missing | What happens |
|---|---|
| TypeScript in the project | The bundled TypeScript 5.9 is used. `status` says so. |
| A project TypeScript without the classic compiler API (TypeScript 7's native port) | The bundled TypeScript is used. `status` names the project's version. |
| `tsconfig.json` / `jsconfig.json` | Default options, reported by `status`. In JavaScript, JSDoc `@param {type}` tags still give parameter types. |
| `node_modules` | Project declarations still resolve. Imports from packages are listed as unresolved, and the answer says to install dependencies. |
| `vendor/` | Project PHP still resolves. Types imported from Composer packages are named but not expanded, and the answer says to run `composer install`. |
| PHP on the machine | Nothing; PHP isn't used. |
| Docblocks and defaults in a package's `.d.ts` | Read from the package's original source: the declaration map, a shipped `src/` folder, or the `sourcesContent` of its JavaScript source maps. |

## What it reads

TypeScript and JavaScript: everything the compiler resolves. Props of
`Omit<…> & {…}` are flattened into one list. Props a type takes from the
standard library or `@types` packages (DOM attributes, `key`, `ref`) are
summarized under the type the code wrote, such as
`+ 269 more from Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "onChange">`. Defaults come from destructuring (`{ size = "md" }`)
and parameter initializers, including inside `forwardRef` and `memo`.

Every custom type an answer refers to by name is defined once in a `types:`
section at the end, closest to the signature first, with generics in their
declared form (`Transform<T>`). The section stops at 8,000 characters and
names the rest; only very large APIs reach that. TypeScript's standard
library and React's own types (`@types/react`, `@types/react-dom`) aren't
defined, since agents know them.

PHP: native types, PHPDoc and PHPStan/Psalm types (`array{…}` shapes, `list<>`,
generics, callables, `@phpstan-type` and `@phpstan-import-type` across
classes), WordPress-style hash notation for array parameters
(`@param array $args { @type string $key … }`), and "Default …" phrases.
Defaults for array keys are also read from code:
`$args['key'] ?? default`, `isset( $args['key'] ) ? … : default`, and merges
with a literal defaults array (`array_merge`, `array_replace`, `wp_parse_args`,
`shortcode_atts`). Files without classes or functions (templates) are
described by their file-level docblock and the keys they read.

## Tests

```sh
npm test
```

The tests run the CLI and an MCP client against the projects in
`test/fixtures/`, including a run with `php` removed from `PATH`.

## License

[PolyForm Strict License 1.0.0](LICENSE.md)
