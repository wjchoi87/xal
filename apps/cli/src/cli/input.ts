export async function askLine(question: string, masked: boolean): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`a terminal is required to enter ${masked ? "a secret" : "a value"}`)
  }

  return new Promise((resolve) => {
    let value = ""
    const wasRaw = process.stdin.isRaw
    const wasFlowing = process.stdin.readableFlowing

    const finish = (result: string | undefined): void => {
      process.stdin.off("data", onData)
      process.stdin.setRawMode(wasRaw)
      if (!wasFlowing) process.stdin.pause()
      process.stdout.write("\n")
      resolve(result)
    }

    const onData = (chunk: Buffer | string): void => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          finish(value)
          return
        }
        if (character === "\u0003" || character === "\u001b") {
          finish(undefined)
          return
        }
        if (character === "\u007f" || character === "\b") {
          if (!value) continue
          value = Array.from(value).slice(0, -1).join("")
          process.stdout.write("\b \b")
          continue
        }
        if (character === "\u0015") {
          process.stdout.write("\b \b".repeat(Array.from(value).length))
          value = ""
          continue
        }
        if (character < " ") continue
        value += character
        process.stdout.write(masked ? "•" : character)
      }
    }

    process.stdout.write(`${question}: `)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on("data", onData)
  })
}
