import assert from "node:assert/strict";
import test from "node:test";
import { PI_COMPATIBILITY_VERSION, listPiPublicExports } from "./index.js";

test("pinned Pi root SDK export imports under the runtime baseline", () => {
  assert.equal(PI_COMPATIBILITY_VERSION, "0.84.1");
  assert.ok(listPiPublicExports().length > 0);
});
