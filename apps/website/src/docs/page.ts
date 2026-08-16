import { appInfo } from "../app-info.ts"
import { escape, inlineHtml, type Document } from "./render.ts"

export type Shell = (options: { title: string; description: string; path: string; body: string }) => string

function rail(documents: Document[], current: Document | undefined): string {
  const entries = documents
    .map((document) => {
      const active = document.slug === current?.slug
      const sections = active
        ? `<ul class="docs-sections">${document.sections
            .map(
              (section) =>
                `<li class="level-${section.level}"><a href="#${section.id}">${inlineHtml(section.text)}</a></li>`,
            )
            .join("")}</ul>`
        : ""
      return `<li><a class="docs-page-link${active ? " active" : ""}" href="/docs/${document.slug}">${escape(
        document.title,
      )}</a>${sections}</li>`
    })
    .join("")

  return `<nav class="docs-rail" aria-label="documentation"><a class="docs-home" href="/docs">Documentation</a><ul class="docs-pages">${entries}</ul></nav>`
}

export function documentPage(shell: Shell, documents: Document[], current: Document): string {
  const body = `<div class="docs-frame">
    ${rail(documents, current)}
    <main class="docs-body">
      <h1>${escape(current.title)}</h1>
      ${current.html}
    </main>
  </div>`

  return shell({
    title: `${current.title} · ${appInfo.name} docs`,
    description: current.intro || `${current.title} reference for ${appInfo.name}.`,
    path: `/docs/${current.slug}`,
    body,
  })
}

export function indexPage(shell: Shell, documents: Document[]): string {
  const cards = documents
    .map(
      (document) => `<li>
        <a class="docs-card-title" href="/docs/${document.slug}">${escape(document.title)}</a>
        <p>${inlineHtml(document.intro)}</p>
        <ul class="docs-card-sections">${document.sections
          .filter((section) => section.level === 2)
          .map((section) => `<li><a href="/docs/${document.slug}#${section.id}">${inlineHtml(section.text)}</a></li>`)
          .join("")}</ul>
      </li>`,
    )
    .join("")

  const body = `<div class="docs-frame">
    ${rail(documents, undefined)}
    <main class="docs-body">
      <h1>Documentation</h1>
      <p>Learn how to install, configure, extend, and operate ${appInfo.name}.</p>
      <ul class="docs-cards">${cards}</ul>
    </main>
  </div>`

  return shell({
    title: `${appInfo.name} documentation`,
    description: `Guides and reference documentation for installing, configuring, extending, and operating ${appInfo.name}.`,
    path: "/docs",
    body,
  })
}
