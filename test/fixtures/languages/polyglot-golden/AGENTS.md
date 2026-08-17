<!-- @cartograph generated -->
# Cartograph

Use the single smallest artifact that fits the question; consult another only if the first is insufficient:

- `.cartograph/architecture.md` — modules and end-to-end flows.
- `cartograph find "<terms>"` — locate symbols lexically when the exact ID is unknown.
- `cartograph inspect "<symbol>"` — inspect one callable or type declaration with callers, callees, location, construction, and boundary metadata.
- `cartograph explore "<symbol>" --depth 2` — expand a bounded subsystem only when repeated local inspection is insufficient.
- `cartograph trace "<from>" "<to>"` — find a shortest static call path. Add `--direction both` when the relationship direction is unknown.
- Compatibility forms `cartograph query find`, `cartograph query inspect`, `cartograph query explore`, and `cartograph query trace` are also supported.
- `.cartograph/<source-path>` — declarations and signatures without bodies.

If the CLI is unavailable, use the generated `node .cartograph/query.mjs` helper. Prefer `find` → `inspect`, then follow returned symbol IDs with more `inspect` calls. Never dump `callgraph.json`, parse it directly, or search it broadly; the query interface intentionally exposes only the requested slice.

Static roots and call paths are navigation evidence, not runtime truth. A missing edge may reflect dynamic dispatch, callbacks, registries, or unresolved value flow. Open only the narrow real-source ranges needed after the graph has identified the implementation path, especially for dynamic dispatch or unresolved calls. Exclude generated files from source searches with `-g '!.cartograph/**'`. Regenerate after structural changes with `cartograph generate`.
