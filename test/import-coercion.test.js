/**
 * The `kept` coercion bug, as a test.
 *
 * import.mjs used `const bool = v => v ? 1 : 0`. RethinkDB is schemaless and
 * 7,873 of 44,589 clover rows store `kept` as `[false]` -- an array containing
 * false. A non-empty array is truthy regardless of contents, so every one of
 * them imported as kept = true, inverting 17.7% of the column. Another 2,190
 * held `[true]` and were right by accident.
 *
 * Nothing caught it for a long time, and it is worth being precise about why:
 * row counts matched exactly at 44,589, because no rows were lost. The damage
 * was inside a column. A parity check that compares which rows exist asks a
 * different question from one that compares what the rows contain, and only the
 * second finds this.
 */
const test = require('node:test')
const assert = require('node:assert')

// The implementation under test, kept in step with migration/sqlite/import.mjs.
const bool = v => {
  if (Array.isArray(v)) {
    if (v.length > 1) throw new Error(`bool() got a ${v.length}-element array: ${JSON.stringify(v)}`)
    v = v[0]
  }
  return v ? 1 : 0
}

test('bool() reads array-wrapped booleans by value, not truthiness', () => {
  // The regression. Truthiness returns 1 here; the value is false.
  assert.strictEqual(bool([false]), 0, '[false] must be false')
  assert.strictEqual(bool([true]), 1, '[true] must be true')
})

test('bool() still handles plain booleans', () => {
  assert.strictEqual(bool(false), 0)
  assert.strictEqual(bool(true), 1)
})

test('bool() treats absent and empty as false', () => {
  // RethinkDB rows can simply lack the field.
  assert.strictEqual(bool(undefined), 0)
  assert.strictEqual(bool(null), 0)
  assert.strictEqual(bool([]), 0)
})

test('bool() refuses a shape this field has never taken', () => {
  // Not defensive noise: a multi-element array would be new drift, and
  // silently reading element zero would hide it the way truthiness hid this.
  assert.throws(() => bool([true, false]), /2-element array/)
})
