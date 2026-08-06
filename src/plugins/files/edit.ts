import { stat } from "node:fs/promises"
import { asBoolean, asString } from "../../lib/json"
import type { Tool } from "../../tools/types"
import { unifiedDiff, withDiff } from "./diff"
import { displayPath, resolveFilePath } from "../../lib/path"
import { pathPermission } from "./permission"

export const editTool: Tool = {
  name: "edit",
  description:
    "Replace an exact string in an existing file. old_string must match the file text exactly and occur exactly once unless replace_all is true. Returns a diff of the change. Paths are absolute or relative to the working directory.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file, absolute or relative to the working directory",
      },
      old_string: {
        type: "string",
        description: "Exact text to replace, copied verbatim from the file including whitespace and indentation",
      },
      new_string: {
        type: "string",
        description: "Replacement text",
      },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence of old_string (default false)",
      },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
  prompt:
    "Use edit for targeted changes to existing files; use write only for new files or full rewrites. Read the file first and copy old_string verbatim — exact match including whitespace, never read's line-number prefixes. Add surrounding lines to old_string to make it unique, or set replace_all to change every occurrence.",
  title(args) {
    return displayPath(asString(args.file_path) ?? "")
  },
  permission(args) {
    return pathPermission("edit", args)
  },
  async execute(args) {
    const path = asString(args.file_path)
    if (!path) throw new Error("file_path is required")
    const oldString = asString(args.old_string)
    if (!oldString) throw new Error("old_string is required and must be non-empty")
    const newString = asString(args.new_string)
    if (newString === undefined) throw new Error("new_string is required")
    if (oldString === newString) throw new Error("old_string and new_string are identical; nothing to change")
    const replaceAll = asBoolean(args.replace_all) ?? false

    const absolute = resolveFilePath(path)
    const stats = await stat(absolute).catch(() => undefined)
    if (!stats) throw new Error(`File not found: ${displayPath(path)}`)
    if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${displayPath(path)}`)

    const previous = await Bun.file(absolute).text()
    const parts = previous.split(oldString)
    const matches = parts.length - 1
    if (matches === 0) {
      throw new Error(
        `old_string not found in ${displayPath(path)}. It must match the file text exactly, including whitespace and indentation.`,
      )
    }
    if (matches > 1 && !replaceAll) {
      throw new Error(
        `old_string matches ${matches} locations in ${displayPath(path)}. Add surrounding lines to make it unique, or set replace_all to true.`,
      )
    }

    const index = previous.indexOf(oldString)
    const next = replaceAll
      ? parts.join(newString)
      : previous.slice(0, index) + newString + previous.slice(index + oldString.length)

    await Bun.write(absolute, next)

    const diff = unifiedDiff(previous, next)
    return { output: withDiff(`Updated ${displayPath(path)} (+${diff.added} -${diff.removed})`, diff.hunks) }
  },
}
