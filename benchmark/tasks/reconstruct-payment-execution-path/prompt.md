When `POST /payments` receives a request, reconstruct the production execution path from HTTP dispatch through database persistence. Identify where validation occurs, the endpoint registration, and the concrete persistence side effect.

Do not modify files and do not run the application. Return only one JSON object with this shape:

{
  "endpoint": {"method": "POST", "path": "/...", "registrationSymbol": "..."},
  "nodes": [
    {"symbol": "Class.method", "path": "repository/relative/file.ts", "role": "one sentence"}
  ],
  "edges": [
    {"from": "Class.method", "to": "Other.method"}
  ],
  "orderedPath": ["first runtime symbol", "next runtime symbol"],
  "validation": {"symbol": "Class.method", "behavior": "what is validated"},
  "sideEffects": ["specific externally observable or persistence effect"]
}

Use only runtime nodes in `nodes`, `edges`, and `orderedPath`; endpoint registration belongs in `endpoint` because it occurs during application setup.
