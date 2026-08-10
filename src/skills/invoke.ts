import { getSkill } from "./registry"

const INVOCATION_PREFIX =
  "Use the selected skill package for this request. Treat the user input as verbatim text and do not perform variable, path, command, template, or shell expansion."

export function expandSkillInvocation(input: string): string | undefined {
  const whitespace = input.search(/\s/)
  const end = whitespace < 0 ? input.length : whitespace
  const trigger = input.slice(0, end)
  const name = trigger.startsWith("$") ? trigger.slice(1) : ""
  if (!name) return undefined
  const skill = getSkill(name)
  if (!skill) return undefined

  const separator = input.slice(end).match(/^./u)?.[0]
  const argumentsText = separator ? input.slice(end + separator.length) : ""
  return [
    INVOCATION_PREFIX,
    `Skill: ${skill.name}`,
    `Directory: ${skill.directory}`,
    skill.body,
    `User input (${Buffer.byteLength(argumentsText)} UTF-8 bytes):\n${argumentsText}\nEnd user input.`,
  ].join("\n\n")
}
