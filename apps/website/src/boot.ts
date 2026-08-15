import { appInfo } from "./app-info.ts"
import { delay, el, reducedMotion } from "./tui/dom.ts"

export async function playBoot(host: HTMLElement): Promise<void> {
  const overlay = el("div", "boot")
  const mark = el("div", "boot-mark")
  const letters = el("span", "boot-letters")
  mark.append(letters)
  mark.append(el("span", "boot-cursor"))
  overlay.append(mark)
  host.append(overlay)

  if (reducedMotion()) {
    letters.textContent = appInfo.name
    await delay(220)
    overlay.remove()
    return
  }

  for (const character of appInfo.name) {
    letters.append(character)
    await delay(90)
  }
  await delay(420)
  overlay.classList.add("leaving")
  await delay(340)
  overlay.remove()
}
