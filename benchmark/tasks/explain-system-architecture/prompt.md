Explain this system's production architecture at a high level without modifying files or running the application. Identify application assembly, the HTTP boundary, validation, domain orchestration, persistence, and the database adapter. Describe the normal `POST /payments` flow in call order and distinguish setup-time endpoint registration from request-time execution.

Return only one JSON object with this shape:

{
  "entrypoint": {"path": "repository/relative/path.ts", "symbol": "..."},
  "components": [
    {"path": "repository/relative/path.ts", "symbol": "ClassOrFunction", "responsibility": "one sentence"}
  ],
  "runtime_flow": ["ordered symbol", "..."],
  "registration": {"path": "repository/relative/path.ts", "symbol": "..."}
}
