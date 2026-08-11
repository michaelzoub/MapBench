Map this repository's production architecture. Do not modify any files and do not run the application.

Return only one JSON object with this shape:

{
  "entrypoint": {"metadata_path": "...", "command": "...", "target": "module:symbol"},
  "components": [
    {"path": "repository/relative/path.py", "symbol": "ClassOrFunction", "responsibility": "one sentence"}
  ],
  "runtime_flow": ["ordered symbol or responsibility", "..."],
  "state_owner": {"path": "repository/relative/path.py", "symbol": "..."}
}

Include the CLI boundary, run orchestration, research-agent construction, trajectory loop, mutable trajectory state, tool capability boundary, persistence, and final-answer validation. The runtime flow must describe the normal production path in call order. Use repository-relative paths and concrete symbol names; do not invent components.
