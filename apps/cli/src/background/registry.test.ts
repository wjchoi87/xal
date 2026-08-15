import { describe, expect, test } from "bun:test"
import { backgroundTasksChanged, subscribeBackgroundTasks } from "./registry"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("background change notifications", () => {
  test("coalesces a progress burst into a leading and one trailing emit", async () => {
    await sleep(200)
    let calls = 0
    const unsubscribe = subscribeBackgroundTasks(() => {
      calls += 1
    })
    for (let index = 0; index < 500; index++) backgroundTasksChanged("progress")
    expect(calls).toBe(1)
    await sleep(250)
    expect(calls).toBe(2)
    unsubscribe()
  })

  test("lifecycle changes emit synchronously and cancel the trailing emit", async () => {
    await sleep(200)
    let calls = 0
    const unsubscribe = subscribeBackgroundTasks(() => {
      calls += 1
    })
    backgroundTasksChanged("progress")
    backgroundTasksChanged("progress")
    expect(calls).toBe(1)
    backgroundTasksChanged("lifecycle")
    expect(calls).toBe(2)
    await sleep(250)
    expect(calls).toBe(2)
    unsubscribe()
  })

  test("a failing listener does not block the others", () => {
    let delivered = false
    const failing = subscribeBackgroundTasks(() => {
      throw new Error("boom")
    })
    const healthy = subscribeBackgroundTasks(() => {
      delivered = true
    })
    backgroundTasksChanged("lifecycle")
    expect(delivered).toBe(true)
    failing()
    healthy()
  })
})
