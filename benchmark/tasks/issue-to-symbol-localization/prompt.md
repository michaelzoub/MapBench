An API client reports this issue:

> POST /payments accepts `CAD` and `USD`, but rejects the equivalent lowercase codes `cad` and `usd`. Currency codes should be normalized before supported-currency validation. Locate the production symbols most relevant to fixing this issue.

Do not modify files and do not run the application. You may retrieve at most 500 lines from real source files; generated project-outline files do not count toward that budget.

Return only one JSON object with this exact shape:

{
  "rankedSymbols": [
    {
      "symbol": "package.module.Class.method",
      "reason": "specific evidence connecting this symbol to the issue",
      "relevance": 0.93
    }
  ]
}

Rank the most relevant symbol first. Relevance must be a number from 0 to 1.
