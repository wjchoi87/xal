import { expect, test } from "bun:test"
import { getCommand, listCommands, registerCommand } from "./registry"
import { runCommand } from "./run"
import type { Command, CommandContext } from "./types"

function command(name: string, aliases?: string[]): Command & { calls: string[][] } {
  const calls: string[][] = []
  return {
    name,
    aliases,
    describe: name,
    calls,
    async run(args) {
      calls.push(args)
    },
  }
}

const context = {} as CommandContext

test("resolves a command by its name and by each alias", async () => {
  const model = command("model", ["m", "models"])
  registerCommand(model)

  expect(getCommand("model")).toBe(model)
  expect(getCommand("m")).toBe(model)
  expect(getCommand("models")).toBe(model)
  expect(getCommand("unknown")).toBeUndefined()
  expect(listCommands()).toContain(model)
  expect(listCommands().filter((entry) => entry.name === "model")).toHaveLength(1)
})

test("refuses a registration that would shadow an existing name or alias", () => {
  registerCommand(command("resume", ["r"]))

  expect(() => registerCommand(command("resume"))).toThrow("command already registered: /resume")
  expect(() => registerCommand(command("restore", ["r"]))).toThrow("command already registered: /r")
  expect(() => registerCommand(command("r"))).toThrow("command already registered: /r")
  expect(() => registerCommand(command("clear", ["c", "c"]))).toThrow("command already registered: /c")
  expect(getCommand("restore")).toBeUndefined()
  expect(getCommand("clear")).toBeUndefined()
})

test("passes the remaining words to the command as arguments", async () => {
  const target = command("bg", ["background"])
  registerCommand(target)

  await runCommand("/bg attach   session-1", context)
  await runCommand("/background   list  ", context)
  await runCommand("/bg", context)

  expect(target.calls).toEqual([["attach", "session-1"], ["list"], []])
})

test("rejects an unknown command and ignores a bare slash", async () => {
  await expect(runCommand("/nope now", context)).rejects.toThrow("unknown command: /nope")
  await expect(runCommand("/", context)).resolves.toBeUndefined()
  await expect(runCommand("/   ", context)).resolves.toBeUndefined()
})

test("propagates a failure raised by the command", async () => {
  registerCommand({
    name: "explode",
    describe: "explode",
    async run() {
      throw new Error("command failed")
    },
  })

  await expect(runCommand("/explode", context)).rejects.toThrow("command failed")
})
