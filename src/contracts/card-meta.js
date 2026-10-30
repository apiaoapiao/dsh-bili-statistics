/**
 * 报告卡片的 wire 契约：宿主 presentationMeta 写出的字段，客户端 src/client.js 的 reportCard 逐字读取。
 * 改字段名必须两边一起改，否则卡片会显示空白而不是报错。
 */
export const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true };

/** 卡片只带展示需要的字段，避免把整份 facts 写进 session 日志。 */
export function cardPayload(run, hypotheses, paths, overview = null, shape = null) {
  const facts = run.facts ?? {};
  return {
    kind: 'bili-intent-report',
    run_id: run.id,
    window: facts.window ?? run.window,
    total_items: facts.total_items ?? run.total_items,
    shape: facts.behavior_shape ? facts.behavior_shape.shape : run.shape,
    confidence: facts.behavior_shape ? facts.behavior_shape.confidence : run.confidence,
    completion: facts.completion_on_active ? facts.completion_on_active.mean_completion_rate : null,
    late_night_share: facts.time_distribution ? facts.time_distribution.after_22_share : null,
    max_chain: facts.passive_chain ? facts.passive_chain.max_consecutive : null,
    baseline: facts.baseline ?? null,
    interactions: facts.interactions
      ? {
          enabled: facts.interactions.enabled !== false,
          likes: Number(facts.interactions.likes?.count ?? 0) || 0,
          coins: Number(facts.interactions.coins?.count ?? 0) || 0,
          coin_total: Number(facts.interactions.coins?.total ?? 0) || 0,
          favorites: Number(facts.interactions.favorites?.count ?? 0) || 0,
          live_minutes: Math.round((Number(facts.interactions.live?.estimated_sec ?? 0) || 0) / 60),
          live_count: Number(facts.interactions.live?.count ?? 0) || 0
        }
      : null,
    overview: typeof overview === 'string' && overview.trim().length > 0 ? overview.trim() : null,
    shape_label: typeof shape?.label === 'string' && shape.label.trim().length > 0 ? shape.label.trim() : null,
    shape_reason: typeof shape?.reason === 'string' && shape.reason.trim().length > 0 ? shape.reason.trim() : null,
    hypotheses: (hypotheses ?? []).map((h) => ({ text: h.text, clue: h.clue ?? null, evidence: h.evidence ?? [] })),
    paths: paths ?? []
  };
}
