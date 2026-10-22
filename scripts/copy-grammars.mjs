// Copy the PHP grammar's WebAssembly build into grammars/, so the published
// package doesn't depend on tree-sitter-php (whose install script compiles
// a native addon on platforms without a prebuilt one).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("tree-sitter-php/package.json"));
const outDir = path.join(root, "grammars");
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(pkgDir, "tree-sitter-php.wasm"), path.join(outDir, "tree-sitter-php.wasm"));
fs.copyFileSync(path.join(pkgDir, "LICENSE"), path.join(outDir, "tree-sitter-php.LICENSE"));
fs.chmodSync(path.join(root, "dist", "cli.js"), 0o755);
console.log("Copied tree-sitter-php.wasm to grammars/");
