import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appInfo } from "../app-info"
import { listSkillFiles, loadSkills, readSkillResource, type SkillRoot } from "./catalog"

async function withSkillsRoot(run: (root: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-skills-test-`))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function writeSkill(directory: string, name: string, frontmatter: string, body: string): Promise<string> {
  const skillDirectory = join(directory, name)
  await mkdir(skillDirectory, { recursive: true })
  const path = join(skillDirectory, "SKILL.md")
  await writeFile(path, `---\n${frontmatter}\n---\n\n${body}\n`)
  return skillDirectory
}

function roots(...directories: [string, SkillRoot["source"]][]): SkillRoot[] {
  return directories.map(([directory, source]) => ({ directory, source }))
}

test("loads skills from every root and lets a later root shadow an earlier name", async () => {
  await withSkillsRoot(async (root) => {
    const user = join(root, "user")
    const project = join(root, "project")
    await writeSkill(user, "deploy", "name: deploy\ndescription: user deploy", "user body")
    await writeSkill(user, "review", "name: review\ndescription: user review", "review body")
    await writeSkill(project, "deploy", "name: deploy\ndescription: project deploy", "project body")

    const skills = await loadSkills(roots([user, "user"], [project, "project"]))

    expect(skills.map((skill) => skill.name)).toEqual(["deploy", "review"])
    expect(skills[0]).toMatchObject({ source: "project", description: "project deploy", body: "project body" })
    expect(skills[1]).toMatchObject({ source: "user", description: "user review" })
  })
})

test("ignores a missing root and finds skills nested below it", async () => {
  await withSkillsRoot(async (root) => {
    await writeSkill(join(root, "present", "vendor", "pack"), "audit", "name: audit\ndescription: audits", "body")

    const skills = await loadSkills(roots([join(root, "absent"), "user"], [join(root, "present"), "project"]))

    expect(skills.map((skill) => skill.name)).toEqual(["audit"])
  })
})

test("rejects skill documents that break the frontmatter contract", async () => {
  await withSkillsRoot(async (root) => {
    const cases: [string, string, string][] = [
      ["no-frontmatter", "", "body without frontmatter"],
      ["bad-name", "name: Bad_Name\ndescription: fine", "body"],
      ["mismatched", "name: other\ndescription: fine", "body"],
      ["empty-body", "name: empty-body\ndescription: fine", ""],
      ["no-description", "name: no-description", "body"],
      ["broken-yaml", "name: [unclosed\ndescription: fine", "body"],
    ]

    for (const [name, frontmatter, body] of cases) {
      const directory = join(root, name)
      await mkdir(join(directory, name), { recursive: true })
      const path = join(directory, name, "SKILL.md")
      await writeFile(path, frontmatter ? `---\n${frontmatter}\n---\n\n${body}\n` : `${body}\n`)
      await expect(loadSkills(roots([directory, "user"]))).rejects.toThrow(path)
    }
  })
})

test("rejects a root that defines the same skill name twice", async () => {
  await withSkillsRoot(async (root) => {
    await writeSkill(join(root, "a"), "deploy", "name: deploy\ndescription: first", "body")
    await writeSkill(join(root, "b"), "deploy", "name: deploy\ndescription: second", "body")

    await expect(loadSkills(roots([root, "user"]))).rejects.toThrow("duplicate skill name: deploy")
  })
})

test("reads supporting files inside the skill directory", async () => {
  await withSkillsRoot(async (root) => {
    const directory = await writeSkill(root, "deploy", "name: deploy\ndescription: deploys", "body")
    await mkdir(join(directory, "references"), { recursive: true })
    await writeFile(join(directory, "references", "steps.md"), "step one")

    const [skill] = await loadSkills(roots([root, "user"]))

    expect(await listSkillFiles(skill!)).toEqual(["references/steps.md"])
    expect(await readSkillResource(skill!, "references/steps.md")).toBe("step one")
  })
})

test("refuses to read a resource that escapes the skill directory", async () => {
  await withSkillsRoot(async (root) => {
    const directory = await writeSkill(join(root, "skills"), "deploy", "name: deploy\ndescription: deploys", "body")
    const outside = join(root, "outside.txt")
    await writeFile(outside, "credentials")
    await symlink(outside, join(directory, "escape.txt"))
    await symlink(root, join(directory, "escape-dir"))

    const [skill] = await loadSkills(roots([join(root, "skills"), "user"]))

    await expect(readSkillResource(skill!, "../outside.txt")).rejects.toThrow("must stay inside the skill directory")
    await expect(readSkillResource(skill!, outside)).rejects.toThrow("must be relative to the skill directory")
    await expect(readSkillResource(skill!, "")).rejects.toThrow("must be relative to the skill directory")
    await expect(readSkillResource(skill!, "escape.txt")).rejects.toThrow("must stay inside the skill directory")
    await expect(readSkillResource(skill!, "escape-dir/outside.txt")).rejects.toThrow(
      "must stay inside the skill directory",
    )
    await expect(readSkillResource(skill!, "missing.txt")).rejects.toThrow("skill file not found: missing.txt")
    expect(await listSkillFiles(skill!)).toEqual([])
  })
})

test("refuses to read a binary supporting file", async () => {
  await withSkillsRoot(async (root) => {
    const directory = await writeSkill(root, "deploy", "name: deploy\ndescription: deploys", "body")
    await writeFile(join(directory, "blob.bin"), Buffer.from([0x68, 0x00, 0x69]))

    const [skill] = await loadSkills(roots([root, "user"]))

    await expect(readSkillResource(skill!, "blob.bin")).rejects.toThrow("skill file is binary: blob.bin")
  })
})
