import { REPOSITORY } from "./content/sections.ts"

function normalizedPath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/"
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function navigation(pathname: string): string {
  const path = normalizedPath(pathname)
  const primary = [
    { href: "/about", label: "/about" },
    { href: "/tools", label: "/tools" },
    { href: "/plugins", label: "/plugins" },
    { href: "/docs", label: "/docs" },
    { href: "/get", label: "/install" },
  ]
    .map(({ href, label }) => {
      const current = path === href
      return `<a class="site-link${isActive(path, href) ? " active" : ""}" href="${href}"${current ? ' aria-current="page"' : ""}>${label}</a>`
    })
    .join("")

  return `<header class="site-header">
    <nav class="site-nav" aria-label="Primary navigation">
      <a class="site-brand" href="/" aria-label="xal home">xal<span class="site-brand-cursor" aria-hidden="true"></span></a>
      <div class="site-links">${primary}</div>
      <div class="site-actions">
        <a class="site-stars" href="${REPOSITORY}/stargazers" target="_blank" rel="noreferrer" aria-label="GitHub stars">
          <span aria-hidden="true">★</span><span class="site-stars-label">Stars</span><span class="site-star-count" hidden></span>
        </a>
        <a class="site-github" href="${REPOSITORY}" target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a>
      </div>
    </nav>
  </header>`
}

export function setNavigationPath(pathname: string): void {
  const path = normalizedPath(pathname)
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".site-link")) {
    const href = link.getAttribute("href")
    if (!href) throw new Error("Navigation link is missing href")
    link.classList.toggle("active", isActive(path, href))
    if (path === href) link.setAttribute("aria-current", "page")
    else link.removeAttribute("aria-current")
  }
}

function githubStars(value: unknown): number {
  if (typeof value !== "object" || value === null || !("stargazers_count" in value)) {
    throw new Error("GitHub repository response is missing stargazers_count")
  }
  if (typeof value.stargazers_count !== "number") {
    throw new Error("GitHub repository stargazers_count is not a number")
  }
  return value.stargazers_count
}

async function updateStarCount(): Promise<void> {
  const node = document.querySelector<HTMLElement>(".site-star-count")
  if (!node) return

  const response = await fetch("https://api.github.com/repos/xal-sh/xal", {
    headers: { Accept: "application/vnd.github+json" },
  })
  if (!response.ok) throw new Error(`GitHub repository request failed with ${response.status}`)

  const value: unknown = await response.json()
  const count = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    githubStars(value),
  )
  if (!(node.parentElement instanceof HTMLAnchorElement)) throw new Error("GitHub stars count is outside its link")
  node.textContent = count
  node.parentElement.setAttribute("aria-label", `GitHub stars: ${count}`)
  node.hidden = false
}

export function installNavigation(): void {
  if (!document.querySelector(".site-header")) {
    document.body.insertAdjacentHTML("afterbegin", navigation(location.pathname))
  }
  void updateStarCount().catch((error: unknown) => console.error("Failed to load GitHub stars", error))
}
