/** Public account fields; passwords and session tokens never appear in JSON. */
export interface UserInfo {
  id: string
  email: string
  role: 'admin' | 'user'
  disabled: boolean
  createdAt: number
}
export type ModelSource = 'shared' | 'byok'
/** POST /api/register and /api/login. Both return AccountResponse and set an HttpOnly cookie. */
export interface AccountCredentials { email: string; password: string }
export interface AccountResponse { user: UserInfo }
/** GET /api/registration; GET/PUT /api/admin/registration. */
export interface RegistrationState { open: boolean }
/**
 * How the server talks to a shared provider: `openai` is any OpenAI Responses-compatible service; `deepseek` is
 * DeepSeek (roadmap-7 C1), whose `deepseek-flash` gets native web tools, the safety check (always on) and titles.
 */
export type ProviderKind = 'openai' | 'deepseek'
/**
 * Admin writes: POST /api/admin/providers, PUT /api/admin/providers/:id. Omit apiKey to retain it on update. For
 * `deepseek`, an empty baseUrl means DEEPSEEK_BASE_URL and empty modelIds mean DeepSeek's current models.
 */
export interface SharedProviderInput { kind: ProviderKind; name: string; baseUrl: string; modelIds: string[]; apiKey?: string }
/** GET /api/admin/providers. Keys remain encrypted on the server, even for admins. */
export interface SharedProviderInfo { id: string; kind: ProviderKind; name: string; baseUrl: string; modelIds: string[]; hasKey: boolean }
/** PATCH /api/admin/users/:id; GET /api/admin/users returns UserInfo[]. */
export interface UserPatch { disabled?: boolean; role?: 'admin' | 'user' }
/** GET /api/admin/usage?from=YYYY-MM-DD&to=YYYY-MM-DD, inclusive UTC days; grouped by user/day/source/model. */
export interface UsageSummary {
  userId: string
  email: string
  day: string
  provider: string
  model: string
  source: ModelSource
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  /** Billable server-side tool calls inside the answers (DeepSeek native search and image search; fetch). */
  searches: number
  fetches: number
}

/**
 * GET /api/admin/usage (everyone) and GET /api/usage (the signed-in user only), `?from=YYYY-MM-DD&to=YYYY-MM-DD`
 * inclusive UTC days: token use per model, and the other services (roadmap-7 C8, D6).
 */
export interface UsageReport {
  models: UsageSummary[]
  services: import('./deepseek.ts').ServiceUsageSummary[]
}
