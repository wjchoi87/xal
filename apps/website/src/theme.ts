export const THEMES = ["dark", "light", "system"] as const

export type Theme = (typeof THEMES)[number]

const STORAGE_KEY = "theme"
const LIGHT_QUERY = "(prefers-color-scheme: light)"

export function isTheme(value: string): value is Theme {
  return THEMES.some((theme) => theme === value)
}

export function storedTheme(): Theme {
  const value = localStorage.getItem(STORAGE_KEY)
  return value && isTheme(value) ? value : "system"
}

export function applyTheme(theme: Theme): void {
  const resolved = theme === "system" ? (matchMedia(LIGHT_QUERY).matches ? "light" : "dark") : theme
  document.documentElement.dataset.theme = resolved
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta instanceof HTMLMetaElement) {
    meta.content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()
  }
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme)
  applyTheme(theme)
}

export function watchSystemTheme(): void {
  matchMedia(LIGHT_QUERY).addEventListener("change", () => {
    if (storedTheme() === "system") applyTheme("system")
  })
}
