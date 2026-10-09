"use strict";
const fs = require("node:fs"), assert = require("node:assert/strict");
function check(text) {
  const numbers = Object.fromEntries([...text.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)].map(m => [m[1], Number(m[2])]));
  assert.ok(numbers.tests > 0 && numbers.tests === numbers.pass, "完整 TAP 汇总必须存在且全部通过");
  for (const k of ["fail", "cancelled", "skipped", "todo"]) assert.equal(numbers[k], 0, k + " 必须为零");
  return numbers;
}
if (require.main === module) console.log(JSON.stringify(check(fs.readFileSync(process.argv[2], "utf8"))));
module.exports = { check };
