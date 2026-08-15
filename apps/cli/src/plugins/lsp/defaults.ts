import type { LspServerConfig } from "./config"

export const defaultLspServers: readonly LspServerConfig[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    fileTypes: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".mts": "typescript",
      ".cts": "typescript",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
    env: {},
    timeoutMs: 30_000,
    install: "npm install --global typescript-language-server typescript",
  },
  {
    id: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    fileTypes: {
      ".py": "python",
      ".pyi": "python",
    },
    rootMarkers: ["pyrightconfig.json", "pyproject.toml", ".git"],
    env: {},
    timeoutMs: 30_000,
    install: "npm install --global pyright",
  },
  {
    id: "rust",
    command: "rust-analyzer",
    args: [],
    fileTypes: {
      ".rs": "rust",
    },
    rootMarkers: ["Cargo.toml", "rust-project.json", ".rust-project.json", ".git"],
    env: {},
    timeoutMs: 30_000,
    install: "rustup component add rust-analyzer",
  },
  {
    id: "go",
    command: "gopls",
    args: [],
    fileTypes: {
      ".go": "go",
    },
    rootMarkers: ["go.work", "go.mod", ".git"],
    env: {},
    timeoutMs: 30_000,
    install: "go install golang.org/x/tools/gopls@latest",
  },
]
