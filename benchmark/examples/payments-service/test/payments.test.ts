import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../src/app.js";

test("POST /payments persists an uppercase-currency payment", async () => {
  const router = createApplication();
  const response = await router.dispatch("POST", "/payments", {
    body: { accountId: "acct-1", amountCents: 2500, currency: "CAD" },
  });
  assert.equal(response.status, 201);
  assert.equal((response.body as { currency: string }).currency, "CAD");
});
