/** `AgentServerMessage.ttft_breakdown` #8: Cursor's own timing of a Run up to its first token. */
export type TtftBreakdown = {
  server_first_token_ms?: number
  pre_stream_setup_ms?: number
  wait_for_first_event_ms?: number
  provider_ttft_ms?: number
  slow_pool_wait_ms?: number
  client_prep_ms?: number
  client_clock?: boolean
}

const ms = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined

/** The Run's time to first token split into Cursor's server before the model and the model's own (`provider_ttft`). */
export function describeTtftBreakdown(breakdown: TtftBreakdown | null | undefined): string | undefined {
  if (!breakdown || typeof breakdown !== "object") return undefined
  const total = ms(breakdown.server_first_token_ms)
  const model = ms(breakdown.provider_ttft_ms)
  if (total === undefined && model === undefined) return undefined
  const cursor = total !== undefined && model !== undefined ? Math.max(0, total - model) : undefined
  const show = (value: number | undefined) => (value === undefined ? "?" : `${value}ms`)
  const parts = [
    `cursor=${show(cursor)}`,
    `model=${show(model)}`,
    `server_first_token=${show(total)}`,
    `pre_stream_setup=${show(ms(breakdown.pre_stream_setup_ms))}`,
    `wait_for_first_event=${show(ms(breakdown.wait_for_first_event_ms))}`,
  ]
  const slowPool = ms(breakdown.slow_pool_wait_ms)
  if (slowPool) parts.push(`slow_pool_wait=${slowPool}ms`)
  const clientPrep = ms(breakdown.client_prep_ms)
  if (clientPrep) parts.push(`client_prep=${clientPrep}ms`)
  if (breakdown.client_clock) parts.push("client_clock")
  return parts.join(" ")
}
