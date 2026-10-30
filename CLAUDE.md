# symbol-mcp

- No framework- or CMS-specific code: no WordPress, Drupal or Laravel function names or conventions in `src/`. Behavior comes from PHP and TypeScript language rules and from what the project declares: types, docblocks, installed stubs, its config files.
- Every call reflects the files on disk at that moment. Adapters re-read in `sync()`, which runs once per request; don't add time-based caches.
- A result that can't be confirmed is kept and marked (`unconfirmed`), not dropped or guessed.
- Output goes into an agent's context, so return only what the agent needs to act.
- `llms-full.txt` and the MCP tool descriptions hold only what changes what the calling agent does: arguments, how to read the output, what to do when it looks wrong. No implementation details, thresholds or design reasons. The README is for the person installing and configuring the server.
