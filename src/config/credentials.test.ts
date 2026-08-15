import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appEnvVar, appInfo } from "../app-info"
import { REDACTION_MARKER, redactText, replaceSecretValues } from "../secrets/redactor"
import {
  loadCredential,
  loadCredentialSecrets,
  saveCredential,
  type ApiKeyCredential,
  type OAuthCredential,
} from "./credentials"

async function withCredentialsHome(run: (home: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-credentials-test-`))
  const home = join(directory, "home")
  const homeEnv = appEnvVar("HOME")
  const inheritedHome = process.env[homeEnv]
  await mkdir(home, { recursive: true })
  process.env[homeEnv] = home
  try {
    await run(home)
  } finally {
    replaceSecretValues("credentials", [])
    if (inheritedHome === undefined) delete process.env[homeEnv]
    else process.env[homeEnv] = inheritedHome
    await rm(directory, { recursive: true, force: true })
  }
}

test("round-trips multiple credential types without replacing other providers", async () => {
  await withCredentialsHome(async (home) => {
    const apiKey: ApiKeyCredential = { type: "api_key", key: "api-secret" }
    const oauth: OAuthCredential = {
      type: "oauth",
      access: "access-secret",
      refresh: "refresh-secret",
      expires: 123456,
      accountId: "account-id",
    }

    await saveCredential("api-provider", apiKey)
    await saveCredential("oauth-provider", oauth)

    expect(await loadCredential("api-provider")).toEqual(apiKey)
    expect(await loadCredential("oauth-provider")).toEqual(oauth)
    const path = join(home, "credentials.json")
    const persisted: unknown = JSON.parse(await readFile(path, "utf8"))
    expect(persisted).toEqual({
      providers: {
        "api-provider": apiKey,
        "oauth-provider": oauth,
      },
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

test("rejects a malformed provider without changing the credential file", async () => {
  await withCredentialsHome(async (home) => {
    const path = join(home, "credentials.json")
    const contents = `${JSON.stringify({
      providers: {
        valid: { type: "api_key", key: "valid-secret" },
        broken: { type: "oauth", access: "access", refresh: "", expires: 123, accountId: "account" },
      },
    })}\n`
    await writeFile(path, contents)

    await expect(loadCredential("valid")).rejects.toThrow(
      `${path} has a malformed credential for broken — fix or delete it`,
    )
    expect(await readFile(path, "utf8")).toBe(contents)
  })
})

test("refreshes registered credential secrets when the file changes", async () => {
  await withCredentialsHome(async (home) => {
    const path = join(home, "credentials.json")
    await writeFile(path, `${JSON.stringify({ providers: { first: { type: "api_key", key: "retired-secret" } } })}\n`)
    await loadCredentialSecrets()
    expect(redactText("retired-secret")).toBe(REDACTION_MARKER)

    await writeFile(
      path,
      `${JSON.stringify({
        providers: {
          second: {
            type: "oauth",
            access: "current-access",
            refresh: "current-refresh",
            expires: 654321,
            accountId: "visible-account",
          },
        },
      })}\n`,
    )
    await loadCredentialSecrets()

    expect(redactText("retired-secret current-access current-refresh visible-account")).toBe(
      `retired-secret ${REDACTION_MARKER} ${REDACTION_MARKER} visible-account`,
    )
  })
})
