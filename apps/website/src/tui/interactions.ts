function highlight(event: Event, active: boolean): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const figure = target.closest(".diagram")
  if (!figure) return
  const part = active ? target.closest("[data-part]")?.getAttribute("data-part") : undefined
  for (const node of figure.querySelectorAll("[data-part]")) {
    node.classList.toggle("lit", part !== undefined && node.getAttribute("data-part") === part)
  }
}

function copy(event: Event): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const action = target.closest(".command-copy")
  if (!(action instanceof HTMLElement)) return
  const text = action.parentElement?.querySelector(".command-text")?.textContent
  if (!text) throw new Error("copy action without a command")

  navigator.clipboard
    .writeText(text)
    .then(() => {
      action.textContent = "copied ✓"
      action.classList.add("done")
    })
    .catch(() => {
      action.textContent = "copy failed"
      action.classList.add("failed")
    })
  setTimeout(() => {
    action.textContent = "copy"
    action.classList.remove("done", "failed")
  }, 1600)
}

export function installInteractions(): void {
  document.addEventListener("mouseover", (event) => highlight(event, true))
  document.addEventListener("mouseout", (event) => highlight(event, false))
  document.addEventListener("focusin", (event) => highlight(event, true))
  document.addEventListener("focusout", (event) => highlight(event, false))
  document.addEventListener("click", copy)
}
