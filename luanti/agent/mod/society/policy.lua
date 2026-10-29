-- society/policy.lua —— 决策层。
--
-- 这一层被刻意与引擎隔开：它只做一件事，读一份 observation，给出一个意图。
-- 它不碰世界、不碰实体、不写日志、不关心时间。
-- M4 要替换的正是这个文件（换成真实 LLM 调用）；上层的生成、推进、执行、
-- 记账与事件格式不应因此改动。这就是把它单独成文件的唯一理由。
--
-- M0 的这版是**确定性桩**，不是随机噪声：每一条判据都来自 observation，
-- 因此它是一个真正的闭环（世界变了，行为才会变），只是不智能。

local M = {}

M.version = "m0-stub-1"

-- 规则按顺序短路。返回一个意图表，执行由 init.lua 负责。
--
--  1. 已有目标未走到        -> advance  先走完手上的路，不重新决策
--  2. 附近没有任何标记      -> mark     在空地上留下痕迹
--  3. 附近标记 >= 3         -> wander   这块地太挤，另选一个目标点
--  4. 有走过但没接触过的邻居 -> approach 走向它（社会性接触）
--  5. 连续两次无事可做      -> wander   不允许原地不动
--  6. 其余                  -> inspect  原地观察，写进记忆
function M.decide(ctx)
  local obs = ctx.observation

  if obs.has_target then
    return {kind = "advance", why = "en-route"}
  end
  if obs.marks_nearby == 0 then
    return {kind = "mark", why = "empty-ground"}
  end
  if obs.marks_nearby >= 3 then
    return {kind = "wander", why = "crowded", point = M.pick_point(ctx)}
  end
  if obs.nearest_unmet_agent then
    return {kind = "approach", why = "unmet-neighbour", target = obs.nearest_unmet_agent}
  end
  if ctx.memory.idle_streak >= 2 then
    return {kind = "wander", why = "stalled", point = M.pick_point(ctx)}
  end
  return {kind = "inspect", why = "no-trigger"}
end

-- 在一定范围内取一个目标点。用 ctx.rng 而不是 math.random：种子固定，
-- 两次同配置的运行必须走出同一串事件。
function M.pick_point(ctx)
  local r = ctx.wander_radius
  return {
    x = ctx.home.x + ctx.rng(2 * r + 1) - r,
    y = ctx.home.y,
    z = ctx.home.z + ctx.rng(2 * r + 1) - r,
  }
end

return M
