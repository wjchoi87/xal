import { applyTheme, storedTheme, watchSystemTheme } from "./theme.ts"
import { installInteractions } from "./tui/interactions.ts"

applyTheme(storedTheme())
watchSystemTheme()
installInteractions()

const root = document.getElementById("app")
if (root) {
  const { startApp } = await import("./app.ts")
  await startApp(root)
}
