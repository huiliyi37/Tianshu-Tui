/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RIVET_PORT?: string
  readonly VITE_RIVET_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
