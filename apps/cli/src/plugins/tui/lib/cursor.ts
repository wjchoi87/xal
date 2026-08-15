const REPLY_TIMEOUT_MS = 150
const REPORT_CURSOR = "\u001b[6n"

export function cursorRow(): Promise<number> {
  const { stdin, stdout } = process
  if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve(0)

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw
    let settled = false

    const finish = (row: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdin.off("data", onData)
      stdin.setRawMode(wasRaw)
      stdin.pause()
      resolve(row)
    }

    let buffer = ""
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()
      const reply = /\[(\d+);\d+R/.exec(buffer)
      if (reply) finish(Number(reply[1]) - 1)
    }

    const timer = setTimeout(() => finish(stdout.rows ?? 0), REPLY_TIMEOUT_MS)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on("data", onData)
    stdout.write(REPORT_CURSOR)
  })
}
