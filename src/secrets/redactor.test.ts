import { afterEach, expect, test } from "bun:test"
import { createRedactedStream, REDACTION_MARKER, redactText, replaceSecretValues } from "./redactor"

afterEach(() => {
  replaceSecretValues("redactor-test", [])
  replaceSecretValues("redactor-other-test", [])
})

test("redacts a secret split at every streaming boundary", () => {
  const secret = "streaming-secret"
  replaceSecretValues("redactor-test", [secret])

  for (let boundary = 0; boundary <= secret.length; boundary++) {
    const stream = createRedactedStream()
    const output =
      stream.write(`before ${secret.slice(0, boundary)}`) +
      stream.write(`${secret.slice(boundary)} after`) +
      stream.end()

    expect(output).toBe(`before ${REDACTION_MARKER} after`)
  }
})

test("flushes an incomplete secret prefix without losing text", () => {
  replaceSecretValues("redactor-test", ["complete-secret"])
  const stream = createRedactedStream()

  const output = stream.write("value: complete-sec") + stream.end()

  expect(output).toBe("value: complete-sec")
})

test("prefers the longest overlapping secret", () => {
  replaceSecretValues("redactor-test", ["token", "token-value"])

  expect(redactText("token-value then token")).toBe(`${REDACTION_MARKER} then ${REDACTION_MARKER}`)
})

test("selects a marker that cannot collide with a secret", () => {
  replaceSecretValues("redactor-test", ["secret-[REDACTED]-value"])

  expect(redactText("secret-[REDACTED]-value and [REDACTED]")).toBe("<hidden> and [REDACTED]")
})

test("replacing one source drops stale secrets without affecting other sources", () => {
  replaceSecretValues("redactor-test", ["retired-secret"])
  replaceSecretValues("redactor-other-test", ["shared-secret"])
  replaceSecretValues("redactor-test", ["current-secret"])

  expect(redactText("retired-secret current-secret shared-secret")).toBe(
    `retired-secret ${REDACTION_MARKER} ${REDACTION_MARKER}`,
  )
})
