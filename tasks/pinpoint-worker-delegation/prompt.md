Pinpoint the implementation of optional delegated-worker execution. Do not modify files and do not run the application.

Return only one JSON object with this shape:

{
  "primary_file": "repository/relative/path.py",
  "assembly": {"path": "...", "symbol": "..."},
  "tool_entry": {"path": "...", "symbol": "..."},
  "admission": {"path": "...", "symbol": "..."},
  "capacity_symbols": ["Class.method", "..."],
  "execution_flow": ["ordered Class.method", "..."],
  "isolation": {"path": "...", "symbol": "...", "mechanism": "one sentence"}
}

Identify where the worker tool is conditionally assembled, where a model-requested delegation enters, where parent capacity and aggregate budget are reserved/released/reconciled, and where the nested agent loop actually runs. Use repository-relative paths and concrete symbols.
