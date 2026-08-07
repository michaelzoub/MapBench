Determine what the `autore` console entrypoint calls. Focus on a normal invocation with a supplied goal: not `eval`, not interactive setup, not model listing, and without preflight enabled. Do not modify files and do not run the application.

Return only one JSON object with this shape:

{
  "metadata": {"path": "...", "command": "...", "target": "module:symbol"},
  "entry_file": "repository/relative/path.py",
  "entry_symbol": "...",
  "direct_calls": ["symbol", "..."],
  "normal_runtime_flow": ["ordered symbol", "..."],
  "conditional_branches": [
    {"condition": "short condition label", "target": "symbol"}
  ]
}

Separate calls made directly by the CLI entry function from the deeper normal runtime path. Include the significant early-exit or optional branches so they are not mistaken for unconditional calls.
