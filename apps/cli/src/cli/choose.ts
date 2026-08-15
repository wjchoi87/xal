export async function chooseOption(options: string[]): Promise<number | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("a terminal is required to choose an option")
  }

  return new Promise((resolve) => {
    let selected = 0
    const wasRaw = process.stdin.isRaw
    const wasFlowing = process.stdin.readableFlowing

    const render = (initial: boolean): void => {
      if (!initial) process.stdout.write(`\u001b[${options.length + 1}A`)
      for (const [index, option] of options.entries()) {
        const line = index === selected ? `\u001b[36m❯ ${index + 1}. ${option}\u001b[0m` : `  ${index + 1}. ${option}`
        process.stdout.write(`\r\u001b[2K  ${line}\n`)
      }
      process.stdout.write("\r\u001b[2K  \u001b[2mEnter confirm · Esc cancel\u001b[0m\n")
    }

    const move = (delta: number): void => {
      selected = (selected + delta + options.length) % options.length
      render(false)
    }

    const finish = (result: number | undefined): void => {
      process.stdin.off("data", onData)
      process.stdin.setRawMode(wasRaw)
      if (!wasFlowing) process.stdin.pause()
      process.stdout.write("\u001b[?25h")
      resolve(result)
    }

    const onData = (chunk: Buffer | string): void => {
      const text = String(chunk)
      let index = 0
      while (index < text.length) {
        const character = text[index]!
        index += 1
        if (character === "\u001b" && text[index] === "[") {
          let end = index + 1
          while (end < text.length && (text[end]! < "@" || text[end]! > "~")) end += 1
          const final = text[end]
          index = end + 1
          if (final === "A") move(-1)
          if (final === "B") move(1)
          continue
        }
        if (character === "\r" || character === "\n") {
          finish(selected)
          return
        }
        if (character === "\u0003" || character === "\u001b") {
          finish(undefined)
          return
        }
        if (character === "k") move(-1)
        if (character === "j") move(1)
        if (character >= "1" && character <= "9" && Number(character) <= options.length) {
          finish(Number(character) - 1)
          return
        }
      }
    }

    process.stdout.write("\u001b[?25l")
    render(true)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on("data", onData)
  })
}
