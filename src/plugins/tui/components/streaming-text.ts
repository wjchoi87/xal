export class StreamingText {
  private buffer = ""

  constructor(private readonly update: (content: string) => void) {}

  append(delta: string): void {
    this.buffer += delta
    this.update(this.buffer)
  }
}
