import { bindings, defineConfig, exports, type WorkerConfig } from 'cf/config'

// `--mode mock` builds the static mock UI as its own Worker (no backend, no secrets).
// Every other mode builds the production Worker; see docs/design/architecture.md.
// `production` is exported so worker code can type its env from it (the default export's
// env is the union of both modes, which makes every binding optional).
export const production = {
  name: 'gensebot',
  compatibilityDate: '2026-10-01',
  compatibilityFlags: ['nodejs_compat'],
  entrypoint: './worker/index.ts',
  observability: { enabled: true },
  assets: {
    notFoundHandling: 'single-page-application',
    runWorkerFirst: ['/agents/*', '/oauth/*', '/api/*'],
  },
  // Access protects only this hostname, so every other URL to the Worker stays off.
  domains: ['bot.rayama.site'],
  workersDev: false,
  previewUrls: false,
  env: {
    UserHub: bindings.durableObject({ worker: 'gensebot', exportName: 'UserHub' }),
    Chat: bindings.durableObject({ worker: 'gensebot', exportName: 'Chat' }),
    ACCESS_TEAM_DOMAIN: bindings.secret(),
    ACCESS_AUD: bindings.secret(),
    ANTHROPIC_BASE_URL: bindings.secret(),
    ANTHROPIC_AUTH_TOKEN: bindings.secret(),
    DEFAULT_ANTHROPIC_MODEL: bindings.secret(),
    OPENAI_BASE_URL: bindings.secret(),
    OPENAI_AUTH_TOKEN: bindings.secret(),
    DEFAULT_OPENAI_MODEL: bindings.secret(),
    GOOGLE_CLIENT_ID: bindings.secret(),
    GOOGLE_CLIENT_SECRET: bindings.secret(),
    TOKEN_ENCRYPTION_KEY: bindings.secret(),
  },
  exports: {
    UserHub: exports.durableObject({ storage: 'sqlite' }),
    Chat: exports.durableObject({ storage: 'sqlite' }),
  },
} satisfies WorkerConfig

export default defineConfig(({ mode }) => {
  if (mode === 'mock') {
    return {
      worker: {
        name: 'gensebot-mock',
        compatibilityDate: '2026-10-01',
        observability: { enabled: true },
        assets: { notFoundHandling: 'single-page-application' },
      },
    }
  }
  return { worker: production }
})
