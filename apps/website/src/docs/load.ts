import { Glob } from "bun"
import { toDocument, type Document } from "./render.ts"

const SOURCE = new URL("../../../../docs/", import.meta.url)

export async function loadDocuments(): Promise<Document[]> {
  const files = [...new Glob("*.md").scanSync(Bun.fileURLToPath(SOURCE))].sort()
  if (files.length === 0) throw new Error(`no markdown found in ${Bun.fileURLToPath(SOURCE)}`)

  const documents: Document[] = []
  for (const file of files) {
    const source = await Bun.file(new URL(file, SOURCE)).text()
    documents.push(toDocument(file.replace(/\.md$/, ""), source))
  }
  return documents
}
