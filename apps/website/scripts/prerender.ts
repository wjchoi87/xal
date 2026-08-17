import { Glob } from "bun"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { Block } from "../src/tui/blocks.ts"
import type { Shell } from "../src/docs/page.ts"

GlobalRegistrator.register()

const { commands } = await import("../src/content/commands.ts")
const content = await import("../src/content/sections.ts")
const { renderBlock } = await import("../src/tui/blocks.ts")
const { approvalFor } = await import("../src/tui/permission.ts")
const { loadDocuments } = await import("../src/docs/load.ts")
const { documentPage, indexPage } = await import("../src/docs/page.ts")
const { navigation } = await import("../src/navigation.ts")

const headers: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
}
if (Bun.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${Bun.env.GITHUB_TOKEN}`

const repository = new URL(content.REPOSITORY)
const response = await fetch(`https://api.github.com/repos${repository.pathname}`, { headers })
if (!response.ok) throw new Error(`GitHub repository request failed with ${response.status}`)

const value: unknown = await response.json()
if (typeof value !== "object" || value === null || !("stargazers_count" in value)) {
  throw new Error("GitHub repository response is missing stargazers_count")
}
const githubStars = value.stargazers_count
if (typeof githubStars !== "number" || !Number.isSafeInteger(githubStars) || githubStars < 0) {
  throw new Error("GitHub repository stargazers_count is not a non-negative integer")
}

const dist = new URL("../dist/", import.meta.url)
const source = await Bun.file(new URL("index.html", dist)).text()

function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function meta(html: string, selector: string, key: string, value: string): string {
  const pattern = new RegExp(`<meta\\s+${selector}="${key}"[\\s\\S]*?/>`)
  if (!pattern.test(html)) throw new Error(`missing <meta ${selector}="${key}"> in shell`)
  return html.replace(pattern, `<meta ${selector}="${key}" content="${attribute(value)}" />`)
}

const shell: Shell = ({ title, description, path, body }) => {
  let html = source.replace(/<title>[^<]*<\/title>/, `<title>${attribute(title)}</title>`)
  html = meta(html, "name", "description", description)
  html = meta(html, "property", "og:title", title)
  html = meta(html, "property", "og:description", description)
  return html
    .replace("</head>", `<link rel="canonical" href="${content.SITE_URL}${path}" />\n  </head>`)
    .replace("<body>", `<body>${navigation(path, githubStars)}`)
    .replace('<div id="app"></div>', body)
}

function stream(blocks: Block[]): string {
  const nodes = blocks.map((block) => renderBlock(block).outerHTML).join("")
  return `<div id="app"><div class="scrollback"><div class="stream">${nodes}</div></div></div>`
}

async function write(path: string, html: string): Promise<void> {
  const file = path === "/" ? new URL("index.html", dist) : new URL(`.${path}/index.html`, dist)
  await Bun.write(file, html)
}

const routes: string[] = []

async function emit(path: string, html: string): Promise<void> {
  await write(path, html)
  routes.push(path)
}

await emit(
  "/",
  shell({
    title: "xal — a terminal coding harness",
    description:
      "A terminal coding harness with a headless agent core, where every capability — including the interface — is a plugin. One compiled binary.",
    path: "/",
    body: stream(content.landing),
  }),
)

for (const command of commands) {
  if (!command.routable) continue
  const blocks: Block[] = []
  await command.run(
    {
      print: async (...items) => {
        blocks.push(...items)
      },
      replaceLast: (block) => {
        blocks[blocks.length - 1] = block
      },
      reset: () => {
        blocks.length = 0
      },
      ask: async (choices) => approvalFor(choices),
      open: () => {},
      visit: () => {},
    },
    "",
  )

  const label = command.name.slice(1)
  const path = command.route ?? command.name
  await emit(
    path,
    shell({
      title: `${label} · xal`,
      description: `${command.describe} — xal, a terminal coding harness with a headless agent core.`,
      path,
      body: stream([content.banner, { kind: "user", text: command.name, at: "" }, ...blocks]),
    }),
  )
}

const documents = await loadDocuments()
await emit(content.DOCS_PATH, indexPage(shell, documents))
for (const document of documents) {
  await emit(`${content.DOCS_PATH}/${document.slug}`, documentPage(shell, documents, document))
}

const publicDir = new URL("../public/", import.meta.url)
const assets = [...new Glob("**/*").scanSync(Bun.fileURLToPath(publicDir))]
for (const asset of assets) {
  await Bun.write(new URL(asset, dist), Bun.file(new URL(asset, publicDir)))
}

const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...routes.map((path) => `  <url><loc>${content.SITE_URL}${path}</loc></url>`),
  "</urlset>",
].join("\n")

await Bun.write(new URL("sitemap.xml", dist), sitemap)
await Bun.write(new URL("robots.txt", dist), `User-agent: *\nAllow: /\nSitemap: ${content.SITE_URL}/sitemap.xml\n`)

console.log(`prerendered ${routes.length} routes: ${routes.join(" ")}`)
