# Integrations

Connect Xal to language servers for semantic code intelligence and MCP servers for external tools, resources, and prompts.

## Language servers

Xal includes lazy language-server recipes for common languages:

| ID           | File suffixes                                                | Command                      | Installation                                                 |
| ------------ | ------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------ |
| `typescript` | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` | `typescript-language-server` | `npm install --global typescript-language-server typescript` |
| `python`     | `.py`, `.pyi`                                                | `pyright-langserver`         | `npm install --global pyright`                               |
| `rust`       | `.rs`                                                        | `rust-analyzer`              | `rustup component add rust-analyzer`                         |
| `go`         | `.go`                                                        | `gopls`                      | `go install golang.org/x/tools/gopls@latest`                 |

Xal checks for these commands on `PATH`, but never downloads or installs them. An installed recipe remains idle until the model queries a matching file. `/lsp` reports missing commands as unavailable with their installation guidance.

### Configure servers

Configure built-in overrides and custom servers under `pluginConfig.lsp.servers`. A built-in entry inherits every omitted recipe field, and `enabled: false` disables it. Custom server names must begin with a lower-case letter and contain only lower-case letters, numbers, hyphens, and underscores.

```json
{
  "pluginConfig": {
    "lsp": {
      "servers": {
        "typescript": {
          "rootMarkers": ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
          "timeoutMs": 45000
        },
        "python": {
          "enabled": false
        },
        "lua": {
          "command": "lua-language-server",
          "fileTypes": {
            ".lua": "lua"
          },
          "rootMarkers": [".luarc.json", ".git"]
        }
      }
    }
  }
}
```

An enabled custom server requires `command` and a non-empty `fileTypes` object mapping filename suffixes to LSP language IDs. Commands must be executable names resolved through `PATH` or absolute paths. Relative executable paths are rejected because servers run from detected project roots. A suffix can belong to only one enabled server, so disable a built-in recipe before assigning its suffixes to a differently named replacement.

`args` and `env` are optional, custom `rootMarkers` default to `[".git"]`, `timeoutMs` defaults to `30000`, and `enabled` defaults to `true`. Supplying `args`, `fileTypes`, or `rootMarkers` on a built-in replaces that recipe field. `initializationOptions` are passed during the LSP handshake; `settings` are sent with `workspace/didChangeConfiguration` after initialization. `${NAME}` references in the command, arguments, and environment values expand from Xal's environment, and secret-like environment values enter its redaction set.

### Runtime behavior

The read-only `lsp` model tool supports definitions, references, hover information, document and workspace symbols, implementations, incoming and outgoing calls, and diagnostics. It starts one server lazily for each matching server and project root. Before every request, Xal reads the current file from disk and synchronizes changed content through the notifications supported by the server. The diagnostics operation uses pull diagnostics when supported and otherwise waits briefly for published diagnostics.

For each file, Xal searches upward for the nearest configured root marker. If none is found, it uses the session working directory for files inside that workspace and the file's directory for external files. `/lsp` shows disabled, unavailable, idle, ready, and failed servers. `/lsp restart [server]` closes matching instances; the next semantic query starts them again. The model-facing tool is available when at least one enabled server command resolves. Language-server commands run as trusted local processes with the server root as their working directory, so only configure executables you trust. Xal closes every started server during shutdown.

## MCP servers

MCP servers are configured under `pluginConfig.mcp.servers`. Server names must begin with a lower-case letter and contain only lower-case letters, numbers, hyphens, and underscores.

```json
{
  "pluginConfig": {
    "mcp": {
      "servers": {
        "local-tools": {
          "transport": "stdio",
          "command": "node",
          "args": ["/absolute/path/to/server.js"],
          "cwd": "/absolute/path/to/project",
          "env": {
            "SERVICE_TOKEN": "${SERVICE_TOKEN}"
          },
          "timeoutMs": 30000
        },
        "remote-tools": {
          "transport": "http",
          "url": "https://example.com/mcp",
          "headers": {
            "Authorization": "Bearer ${MCP_TOKEN}"
          }
        }
      }
    }
  }
}
```

Each server supports `enabled`, which defaults to `true`, and `timeoutMs`, which defaults to `30000`. A stdio server requires `command`, accepts optional `args`, `cwd`, and `env`, and inherits the SDK's safe default process environment. Relative `cwd` values resolve from the directory where Xal starts. An HTTP server requires `url` and accepts optional `headers`; Xal tries Streamable HTTP first and falls back to legacy SSE at the same URL only when the initial Streamable HTTP request receives a 4xx response.

If a higher-priority configuration changes an existing server's transport, fields inherited for the inactive transport are ignored. Unknown field names still fail configuration.

`${NAME}` references in commands, arguments, working directories, environment values, URLs, and headers expand from Xal's environment. A missing variable makes the MCP configuration fail instead of starting with an incomplete value. Values in secret-like environment variables and headers are added to Xal's redaction set.

### MCP runtime behavior

Servers connect in parallel during plugin bootstrap. One unavailable server is reported as failed without hiding tools from healthy servers. Discovered tools use names such as `mcp__local-tools__count`, retain their remote input schemas, and pass through normal permission handling. Every remote MCP call is treated as an unsandboxed mutation and invalidates workspace redo history because server annotations are untrusted hints and the tool's effects are external or unknown. Reading a remote resource or resolving a remote prompt also requires approval; listing their already-cached catalogs remains read-only.

Connected resource catalogs, resource templates, and prompts are exposed through `mcp_resources`, `mcp_read_resource`, `mcp_prompts`, and `mcp_get_prompt`. Server instructions join the system prompt. Binary resource and image or audio content is summarized with its media type and byte size because Xal's tool-result boundary is text-only. Tools that require the experimental MCP task protocol, or whose output schema uses an unsupported dialect, are skipped and reported in status. Ordinary and task-optional tools remain available.

Tool-list change notifications refresh registered tools, and `/mcp reconnect [server]` reconnects one server or all servers. Run `/mcp` to see transport, status, and capability counts.
