import { stat } from "node:fs/promises"
import { asString } from "../../lib/json"
import type { Tool } from "../../tools/types"
import { unifiedDiff, withDiff } from "./diff"
import { displayPath, resolveFilePath } from "../../lib/path"
import { pathPermission } from "./permission"

export const writeTool: Tool = {
  name: "write",
  description:
    "Write a file with the given content, creating it and any missing parent directories or replacing the existing file entirely. Returns a diff of the change. Paths are absolute or relative to the working directory.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file, absolute or relative to the working directory",
      },
      content: {
        type: "string",
        description: "Full file content as raw text; replaces anything already in the file",
      },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
  prompt:
    "Use write for new files and complete rewrites; prefer edit for changing part of an existing file. Read an existing file before overwriting it, and pass raw file text without read's line-number prefixes. Do not create documentation or README files unless the user asks for them.",
  title(args, ctx) {
    return displayPath(asString(args.file_path) ?? "", ctx.cwd)
  },
  undo(args, ctx) {
    const path = asString(args.file_path)
    return path ? { type: "paths", paths: [resolveFilePath(path, ctx.cwd)] } : { type: "none" }
  },
  permission(args, ctx) {
    return pathPermission("write", args, ctx.cwd)
  },
  async execute(args, ctx) {
    const path = asString(args.file_path)
    if (!path) throw new Error("file_path is required")
    const content = asString(args.content)
    if (content === undefined) throw new Error("content is required")

    const absolute = resolveFilePath(path, ctx.cwd)
    const stats = await stat(absolute).catch(() => undefined)
    if (stats?.isDirectory()) throw new Error(`Path is a directory, not a file: ${displayPath(path, ctx.cwd)}`)

    const previous = stats ? await Bun.file(absolute).text() : undefined
    if (previous === content) return { output: `Unchanged ${displayPath(path, ctx.cwd)}` }

    await Bun.write(absolute, content)

    if (previous === undefined) {
      const diff = unifiedDiff("", content)
      return { output: withDiff(`Created ${displayPath(path, ctx.cwd)} (${diff.added} lines)`, diff.hunks) }
    }
    const diff = unifiedDiff(previous, content)
    return {
      output: withDiff(`Updated ${displayPath(path, ctx.cwd)} (+${diff.added} -${diff.removed})`, diff.hunks),
    }
  },
}
