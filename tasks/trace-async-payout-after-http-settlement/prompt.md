A merchant reports this production behavior for a paid `GET /products/:productId` request:

- the buyer receives HTTP 200 and a successful `payment-response` transaction hash;
- the payment record is `SETTLED`;
- its payout record is still `PENDING`;
- the merchant router holds the full gross payment; and
- the seller and treasury balances are still zero.

Determine whether this evidence shows a failed smart-contract payout or an expected intermediate state. Trace the complete production execution path from the Express integration and x402 verification/settlement hooks, through durable persistence and background processing, to the contract call that transfers seller and treasury funds.

Your answer must distinguish the two on-chain transactions, give the payment and payout state transitions, identify which off-chain process initiates distribution, explain lost-broadcast recovery and duplicate-execution protection, and state what an operator should inspect if the payout remains unfinished.

Do not modify files or run the application. Ground the answer in production source; tests may corroborate the answer but cannot replace tracing the implementation.

Return only one JSON object with this shape:

{
  "verdict": "short stable identifier",
  "explanation": "concise root-cause analysis",
  "settlement_boundary": {
    "payment_status": "...",
    "payout_status": "...",
    "funds_holder": "..."
  },
  "payment_states": ["ordered state", "..."],
  "payout_states": ["ordered state", "..."],
  "onchain_calls": [
    {"contract": "payment-token or source contract name", "function": "...", "recipient": "...", "effect": "..."}
  ],
  "production_path": [
    {"path": "repository/relative/path", "symbol": "concrete symbol", "responsibility": "one sentence"}
  ],
  "replay_guards": ["concrete contract symbol", "..."],
  "operator_checks": ["concrete persisted state, process, receipt, or event to inspect", "..."]
}
