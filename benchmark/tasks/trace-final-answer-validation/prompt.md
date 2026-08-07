A developer needs to change the policy that accepts a proposed final answer or sends it back for revision. Locate the policy implementation and trace its production integration and control-flow impact. Do not modify files and do not run the application.

Return only one JSON object with this shape:

{
  "policy": {"path": "repository/relative/path.py", "symbol": "Class.method"},
  "construction": {"path": "...", "symbol": "Class.method"},
  "call_site": {"path": "...", "symbol": "Class.method"},
  "configuration": {"path": "...", "symbol": "Class.field"},
  "execution_flow": ["ordered Class.method", "..."],
  "outcome_targets": ["Class.method", "..."],
  "revision_behavior": "one sentence using the concrete state counter and configured limit names"
}

Identify where the validator is created, which surrounding loop method invokes it, the ordered path from the production loop to validation, and the targets reached when validation passes, requests another revision, or exhausts the configured revision limit. Use repository-relative paths and concrete symbol names.
