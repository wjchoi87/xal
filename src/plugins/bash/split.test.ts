import { describe, expect, test } from "bun:test"
import { splitCommand } from "./split"

describe("splitCommand", () => {
  test("splits every supported command separator", () => {
    for (const example of [
      { command: "git status && bun test", segments: ["git status", "bun test"] },
      { command: "bun test || bun run lint", segments: ["bun test", "bun run lint"] },
      { command: "printf ready | wc -c", segments: ["printf ready", "wc -c"] },
      { command: "bun test; bun run lint", segments: ["bun test", "bun run lint"] },
      { command: "bun test\nbun run lint", segments: ["bun test", "bun run lint"] },
    ]) {
      expect(splitCommand(example.command)).toEqual({ segments: example.segments, redirected: false })
    }
  })

  test("keeps quoted and escaped separators within their command", () => {
    expect(splitCommand("printf '%s' 'left && right | still; one\ntwo' && next")).toEqual({
      segments: ["printf '%s' 'left && right | still; one\ntwo'", "next"],
      redirected: false,
    })
    expect(splitCommand('printf "%s" "left && right | still; one" | next')).toEqual({
      segments: ['printf "%s" "left && right | still; one"', "next"],
      redirected: false,
    })
    expect(splitCommand("echo left \\| right \\; still \\&\\& one")).toEqual({
      segments: ["echo left \\| right \\; still \\&\\& one"],
      redirected: false,
    })
    expect(splitCommand("echo 'left > right'")).toEqual({
      segments: ["echo 'left > right'"],
      redirected: false,
    })
  })

  test("tracks redirections without treating them as command separators", () => {
    expect(splitCommand("sort < input | uniq > output")).toEqual({
      segments: ["sort < input", "uniq > output"],
      redirected: true,
    })
    expect(splitCommand("command 2>> errors 2>&1 &> all")).toEqual({
      segments: ["command 2>> errors 2>&1 &> all"],
      redirected: true,
    })
  })

  test("rejects shell constructs that cannot be split safely", () => {
    for (const command of [
      "echo $(date)",
      'echo "$(date)"',
      "echo `date`",
      "(echo grouped)",
      "{ echo grouped; }",
      "echo first & echo second",
    ]) {
      expect(splitCommand(command)).toBeUndefined()
    }
  })

  test("rejects input without a command", () => {
    for (const command of ["", "   ", "&& || ; |\n"]) {
      expect(splitCommand(command)).toBeUndefined()
    }
  })
})
