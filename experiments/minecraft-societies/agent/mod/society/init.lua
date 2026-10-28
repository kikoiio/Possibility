-- society/init.lua —— M0：Luanti 服务端 agent 的最小闭环。
--
-- 本文件要证明的事情只有三件，正好是 M0 的退出条件：
--   1. 可以重复启停；
--   2. agent 确实每个 server step 都被引擎推进；
--   3. 失败时给出明确原因，而不是静默消失。
--
-- 它**不**做的事：不接 LLM（M4）、不做持久化与快照（M3）、不做规模阶梯（M1）。
-- 决策是 policy.lua 里的确定性桩，这样环境问题与模型问题不会混在一起。
--
-- 一条刻意的分工，不要改成「在 on_step 里决策」：
--   * 每个实体的 on_step 只累加自己的步数计数 —— 这是「被推进」的证据；
--   * 一个 globalstep 驱动按 agent id 排序依次决策 —— 这是事件序列可重复的前提。
-- 引擎遍历活跃区块的顺序不保证稳定，把决策放进 on_step 会让日志交错随机化。

local policy = dofile(minetest.get_modpath("society") .. "/policy.lua")
local cognition_observe = dofile(minetest.get_modpath("society") .. "/observation.lua")
local cognition_memory = dofile(minetest.get_modpath("society") .. "/memory.lua")
local persistence = dofile(minetest.get_modpath("society") .. "/persistence.lua")
local resources = dofile(minetest.get_modpath("society") .. "/resource_actions.lua")

local function cfg(name, default)
	return minetest.settings:get(name) or default
end

local COUNT = tonumber(cfg("society_count", "5"))
local INTERVAL = tonumber(cfg("society_decide_interval", "2.0"))
local MAX_DECISIONS = tonumber(cfg("society_max_decisions", "10"))
local SEED = tonumber(cfg("society_seed", "20261027"))
local SPACING = tonumber(cfg("society_spacing", "8"))
local BOUND = tonumber(cfg("society_bound", "32"))
local WANDER = tonumber(cfg("society_wander_radius", "12"))
local SENSE = tonumber(cfg("society_sense_radius", "12"))
local STEP = tonumber(cfg("society_step", "2"))
local STATS_EVERY = tonumber(cfg("society_stats_interval", "5"))
local ORIGIN = {x = 0, y = 1, z = 0}
local MARK_NODE = cfg("society_mark_node", "society:mark")
local COGNITION = cfg("society_cognition", "false") == "true"
local MODEL = cfg("society_model", "false") == "true"
local MODEL_MEMORY = cfg("society_model_memory", "true") == "true"
local LOG_MESSAGES = cfg("society_log_messages", "false") == "true"
local PERSIST = cfg("society_persist", "false") == "true"
local RESTORE = cfg("society_restore", "false") == "true"
local RESET_MINDS = cfg("society_reset_minds", "false") == "true"
local storage = minetest.get_mod_storage()
local initial_state = storage:get_string("agent_state")
if PERSIST then storage:set_string("agent_state", "") end
local SPOOL = cfg("society_spool", "")
local request_id = 0

-- persona 在 M0 里只是一个稳定标签，不影响行为；M2 起它才承载设定。
local PERSONAS = {
	"atlas", "birch", "cinder", "delta", "ember", "flint", "gale", "harbor",
}
local FACINGS = {
	{x = 1, z = 0}, {x = 0, z = 1}, {x = -1, z = 0}, {x = 0, z = -1},
}
local ACTION_ORDER = {"advance", "approach", "inspect", "mark", "wander", "say", "gather", "build", "unknown"}

local S = {
	spawned = 0, decisions = 0, marks = 0, meets = 0,
	actions = {}, step_ticks = 0, driver_rounds = 0,
	finished = false, failed = nil,
}

local agents = {}
local live = {}          -- 上一次统计时每个 agent 的 _steps 快照

local function ev(fmt, ...)
	minetest.log("action", "SOCIETY " .. string.format(fmt, ...))
end

local function fp(v)
	return math.floor(v)
end

local function in_bounds(p)
	return math.abs(p.x) <= BOUND and math.abs(p.z) <= BOUND
end

local function action_string()
	local parts = {}
	for _, k in ipairs(ACTION_ORDER) do
		parts[#parts + 1] = string.format("%s:%d", k, S.actions[k] or 0)
	end
	return table.concat(parts, ",")
end

local function alive_agents()
	local n = 0
	for i = 0, COUNT - 1 do
		local le = agents[i]
		if le and le.object and le.object:get_pos() then
			n = n + 1
		end
	end
	return n
end

-- 世界差异：标记节点。放在同 mod 内，避免依赖 minetest_game 的方块名。
minetest.register_node("society:mark", {
	description = "society mark",
	tiles = {"default_stone.png^[colorize:#c9a227:200"},
	groups = {cracky = 3, oddly_breakable_by_hand = 3},
})
minetest.register_node("society:resource", {
	description = "society resource", tiles = {"default_stone.png^[colorize:#33aa66:180"},
	groups = {cracky = 3},
})

-- 确定性 PRNG：每个 agent 一份状态，种子固定。
-- 不用 math.random，因为它受引擎与调用顺序影响，两次运行不一定给出同一序列。
local function rng_next(self, n)
	self._rng = (self._rng * 1103515245 + 12345) % 2147483648
	return self._rng % n
end

local function observe(self, pos)
	local nearby_agents = {}
	local nearest, nearest_d = nil, nil
	for _, obj in ipairs(minetest.get_objects_inside_radius(pos, SENSE)) do
		if obj ~= self.object then
			local le = obj:get_luaentity()
			if le and le.name == "society:agent" and le._id then
				local op = obj:get_pos()
				if op then
					local d = math.max(math.abs(op.x - pos.x), math.abs(op.z - pos.z))
					nearby_agents[#nearby_agents + 1] = le._id
					if not nearest_d or d < nearest_d then
						nearest, nearest_d = le._id, d
					end
				end
			end
		end
	end

	local marks = #minetest.find_nodes_in_area(
		{x = pos.x - SENSE, y = pos.y - 2, z = pos.z - SENSE},
		{x = pos.x + SENSE, y = pos.y + 2, z = pos.z + SENSE},
		{MARK_NODE})

	-- 只要最近的那个邻居还没接触过就报出来：policy 据此决定靠近谁。
	local unmet = nil
	if nearest and not self._memory.met[nearest] then
		unmet = nearest
	end

	return {
		pos = pos,
		nearby_agents = nearby_agents,
		nearest_agent = nearest,
		nearest_distance = nearest_d,
		nearest_unmet_agent = unmet,
		marks_nearby = marks,
		has_target = self._target ~= nil,
		self_marks = self._marks_placed,
	}
end

local function step_toward(self, pos, target)
	local dx = target.x - pos.x
	local dz = target.z - pos.z
	local nx, nz = pos.x, pos.z
	if math.abs(dx) >= math.abs(dz) and dx ~= 0 then
		nx = pos.x + (dx > 0 and math.min(STEP, dx) or -math.min(STEP, -dx))
	elseif dz ~= 0 then
		nz = pos.z + (dz > 0 and math.min(STEP, dz) or -math.min(STEP, -dz))
	end
	local np = {x = fp(nx), y = fp(target.y), z = fp(nz)}
	if not in_bounds(np) then
		return nil
	end
	self.object:set_pos(np)
	return np
end

local function apply(self, action, pos)
	local kind = action.kind or "unknown"
	S.actions[kind] = (S.actions[kind] or 0) + 1

	if kind == "advance" then
		local np = step_toward(self, pos, self._target)
		if not np then
			ev("ev=target-dropped agent=%d persona=%s reason=out-of-bounds", self._id, self._persona)
			self._target = nil
			return
		end
		local d = math.max(math.abs(self._target.x - np.x), math.abs(self._target.z - np.z))
		ev("ev=move agent=%d persona=%s to=%d,%d,%d remaining=%d why=%s",
			self._id, self._persona, np.x, np.y, np.z, d, action.why or "-")
		if d <= STEP then
			self._target = nil
			ev("ev=arrive agent=%d persona=%s at=%d,%d,%d", self._id, self._persona, np.x, np.y, np.z)
		end
		return
	end

	if kind == "wander" then
		local p = action.point
		self._target = {x = fp(p.x), y = fp(p.y), z = fp(p.z)}
		ev("ev=wander agent=%d persona=%s why=%s target=%d,%d,%d",
			self._id, self._persona, action.why or "-", self._target.x, self._target.y, self._target.z)
		self._memory.idle_streak = 0
		return
	end

	if kind == "approach" then
		local le = agents[action.target]
		local tp = le and le.object and le.object:get_pos()
		if not tp then
			ev("ev=approach-failed agent=%d persona=%s target=%s reason=gone",
				self._id, self._persona, tostring(action.target))
			self._memory.idle_streak = self._memory.idle_streak + 1
			return
		end
		-- 走到「身边」而不是「身上」：停在一步之外，别和对方重叠。
		local tx, tz = fp(tp.x), fp(tp.z)
		if math.abs(tx - pos.x) >= math.abs(tz - pos.z) then
			tx = tx + (pos.x > tx and STEP or -STEP)
		else
			tz = tz + (pos.z > tz and STEP or -STEP)
		end
		self._target = {x = tx, y = fp(tp.y), z = tz}
		ev("ev=approach agent=%d persona=%s target=%d at=%d,%d,%d",
			self._id, self._persona, action.target,
			self._target.x, self._target.y, self._target.z)
		self._memory.idle_streak = 0
		return
	end

	if kind == "mark" then
		local f = self._facing
		local at = {x = fp(pos.x) + f.x, y = fp(pos.y), z = fp(pos.z) + f.z}
		if not in_bounds(at) then
			ev("ev=mark-skipped agent=%d persona=%s at=%d,%d,%d reason=out-of-bounds",
				self._id, self._persona, at.x, at.y, at.z)
			self._memory.idle_streak = self._memory.idle_streak + 1
			return
		end
		local before = minetest.get_node(at).name
		if before ~= "air" then
			-- 位置已被占（别的 agent 或地图本身）：不能假装成功
			ev("ev=mark-skipped agent=%d persona=%s at=%d,%d,%d reason=occupied by=%s",
				self._id, self._persona, at.x, at.y, at.z, before)
			self._memory.idle_streak = self._memory.idle_streak + 1
			return
		end
		minetest.set_node(at, {name = MARK_NODE})
		local after = minetest.get_node(at).name
		if after ~= MARK_NODE then
			-- 写了但没落地：必须报出来，不能计入成功
			ev("ev=mark-failed agent=%d persona=%s at=%d,%d,%d after=%s",
				self._id, self._persona, at.x, at.y, at.z, after)
			self._memory.idle_streak = self._memory.idle_streak + 1
			return
		end
		S.marks = S.marks + 1
		self._marks_placed = self._marks_placed + 1
		ev("ev=mark agent=%d persona=%s at=%d,%d,%d marks_total=%d",
			self._id, self._persona, at.x, at.y, at.z, S.marks)
		self._memory.idle_streak = 0
		return
	end

	if kind == "inspect" then
		self._memory.idle_streak = self._memory.idle_streak + 1
		ev("ev=inspect agent=%d persona=%s at=%d,%d,%d neighbours=%d marks_nearby=%d",
			self._id, self._persona, fp(pos.x), fp(pos.y), fp(pos.z),
			#action.observation.nearby_agents, action.observation.marks_nearby)
		return
	end

	if kind == "gather" or kind == "build" then
		local ok, reason = self._resources[kind](self._resources, action.point, "society:resource")
		ev("ev=resource agent=%d action=%s ok=%s reason=%s inventory=%d", self._id, kind,
			tostring(ok), tostring(reason or "none"):gsub("%s+", "_"), self._resources:count("society:resource"))
		return
	end
	if kind == "say" then
		local recipient = agents[action.target]
		if recipient then
			recipient._episodic:add({time = minetest.get_gametime(), text = action.text,
				source = {kind = "agent", id = self._id}})
			self._episodic:add({time = minetest.get_gametime(), text = action.text,
				source = {kind = "self", id = self._id}})
			ev("ev=message agent=%d recipient=%d sha256=%s", self._id, action.target,
				minetest.sha256(action.text))
			if LOG_MESSAGES then
				ev("ev=message-text agent=%d recipient=%d text=%s", self._id, action.target,
					minetest.write_json(action.text):gsub("[\r\n]", ""))
			end
		end
		return
	end
	self._memory.idle_streak = self._memory.idle_streak + 1
	ev("ev=unknown-action agent=%d persona=%s kind=%s", self._id, self._persona, kind)
end

-- 走到邻居身边时记一次接触：这不是决策，是执行结果反馈进记忆。
local function settle_contacts(self, pos)
	for _, obj in ipairs(minetest.get_objects_inside_radius(pos, STEP + 1)) do
		if obj ~= self.object then
			local le = obj:get_luaentity()
			if le and le.name == "society:agent" and le._id and le._memory
					and not self._memory.met[le._id] then
				self._memory.met[le._id] = true
				le._memory.met[self._id] = true
				S.meets = S.meets + 1
				ev("ev=meet agent=%d persona=%s with=%d persona=%s at=%d,%d,%d",
					self._id, self._persona, le._id, le._persona, fp(pos.x), fp(pos.y), fp(pos.z))
			end
		end
	end
end

local function decide_and_act(self)
	local pos = self.object:get_pos()
	if not pos then
		ev("fail=no-position agent=%d persona=%s", self._id, self._persona)
		return
	end
	pos = {x = fp(pos.x), y = fp(pos.y), z = fp(pos.z)}

	local obs = observe(self, pos)
	if COGNITION and not self._pending then
		local local_obs, err = cognition_observe.observe(minetest, self.object,
			{radius = SENSE, node_names = {MARK_NODE, "society:resource"}})
		if not local_obs then
			ev("fail=observation agent=%d reason=%s", self._id, err)
			S.failed = "observation"
			minetest.request_shutdown()
			return
		end
		self._episodic:add({time = minetest.get_gametime(),
			text = string.format("nearby agents=%d marks=%d", #local_obs.agents, #local_obs.nodes),
			source = {kind = "observation", id = self._id}})
		obs.local_view = local_obs
	end
	local action
	if MODEL then
		if not self._pending then
			request_id = request_id + 1
			local context = {observation = {has_target = obs.has_target,
				nearby_agents = obs.nearby_agents, pos = obs.pos, marks_nearby = obs.marks_nearby},
				persona = self._persona, goal = "Explore, gather resources, build, and interact with nearby agents.",
				visible_nodes = obs.local_view and obs.local_view.nodes or {},
				inventory = self._resources:inventory(),
				memory = MODEL_MEMORY and self._episodic:list() or {},
				bounds = {min = {x = -BOUND, y = pos.y, z = -BOUND},
					max = {x = BOUND, y = pos.y, z = BOUND}}}
			local path = SPOOL .. "/request-" .. request_id .. ".json"
			local encoded = string.format('{"id":%d,"context":%s}', request_id, minetest.write_json(context))
			if not minetest.safe_file_write(path, encoded) then
				ev("fail=model-request-write agent=%d", self._id)
				S.failed = "model-request-write"
				minetest.request_shutdown()
				return
			end
			self._pending = {id = request_id, started = minetest.get_us_time()}
			ev("ev=model-request agent=%d request=%d", self._id, request_id)
			return
		end
		local path = SPOOL .. "/response-" .. self._pending.id .. ".json"
		local f = io.open(path, "r")
		if not f then
			if minetest.get_us_time() - self._pending.started > (COUNT * 135 + 30) * 1000000 then
				ev("fail=model-timeout agent=%d request=%d", self._id, self._pending.id)
				S.failed = "model-timeout"
				minetest.request_shutdown()
			end
			return
		end
		local result = minetest.parse_json(f:read("*a"))
		f:close()
		os.remove(path)
		local id = self._pending.id
		self._pending = nil
		if result and type(result.attempts) == "table" then
			for n, attempt in ipairs(result.attempts) do
				local audit = attempt.audit or {}
				local usage = audit.usage or {}
				ev("ev=model-attempt agent=%d request=%d attempt=%d ok=%s error=%s latency_ms=%s input_tokens=%s output_tokens=%s",
					self._id, id, n, tostring(attempt.ok), tostring(attempt.error or "none"),
					tostring(audit.latency_ms or "unknown"), tostring(usage.input_tokens or "unknown"),
					tostring(usage.output_tokens or "unknown"))
			end
		end
		if not result or result.id ~= id or result.ok ~= true or type(result.action) ~= "table" then
			local audit = result and result.audit or {}
			local usage = audit.usage or {}
			ev("fail=model-response agent=%d request=%d error=%s latency_ms=%s input_tokens=%s output_tokens=%s", self._id, id,
				result and tostring(result.error) or "invalid", tostring(audit.latency_ms or "unknown"),
				tostring(usage.input_tokens or "unknown"), tostring(usage.output_tokens or "unknown"))
			S.failed = "model-response"
			minetest.request_shutdown()
			return
		end
		action = result.action
		local valid = action.kind == "inspect" or action.kind == "mark"
			or (action.kind == "advance" and self._target ~= nil)
		if action.kind == "approach" or action.kind == "say" then
			for _, other in ipairs(obs.nearby_agents) do
				if other == action.target then valid = true end
			end
			if action.kind == "say" then
				valid = valid and type(action.text) == "string" and #action.text > 0
					and #action.text <= 240 and not action.text:find("[%c]")
			end
		elseif (action.kind == "wander" or action.kind == "gather" or action.kind == "build") and type(action.point) == "table" then
			local p = action.point
			valid = type(p.x) == "number" and type(p.y) == "number" and type(p.z) == "number"
				and p.x == math.floor(p.x) and p.z == math.floor(p.z)
				and p.y == pos.y and in_bounds(p)
		end
		if not valid then
			ev("ev=model-stale agent=%d request=%d", self._id, id)
			return
		end
		local audit = result.audit or {}
		local usage = audit.usage or {}
		ev("ev=model-action agent=%d request=%d kind=%s latency_ms=%s input_tokens=%s output_tokens=%s",
			self._id, id, action.kind, tostring(audit.latency_ms or "unknown"),
			tostring(usage.input_tokens or "unknown"), tostring(usage.output_tokens or "unknown"))
	else
		action = policy.decide({
		id = self._id,
		persona = self._persona,
		home = self._home,
		pos = pos,
		observation = obs,
		memory = self._memory,
		wander_radius = WANDER,
		rng = function(n) return rng_next(self, n) end,
		})
	end
	action.observation = obs
	apply(self, action, pos)

	self._decisions = self._decisions + 1
	S.decisions = S.decisions + 1

	local after = self.object:get_pos()
	if after then
		settle_contacts(self, {x = fp(after.x), y = fp(after.y), z = fp(after.z)})
	end
end

minetest.register_entity("society:agent", {
	initial_properties = {
		visual = "cube",
		visual_size = {x = 0.7, y = 0.7, z = 0.7},
		textures = {"default_stone.png^[colorize:#7fc7ff:170"},
		physical = false,
		collide_with_objects = false,
		pointable = false,
		static_save = false,   -- M0 不持久化；重启由实验脚本重新生成（持久化是 M3）
	},
	on_activate = function(self)
		self._steps = 0
		self._acc = 0
	end,
	-- 只记数。这是「agent 确实每步被推进」的唯一证据来源。
	on_step = function(self, dtime)
		self._steps = (self._steps or 0) + 1
		S.step_ticks = S.step_ticks + 1
	end,
})

local function spawn_agents()
	local saved
	if RESTORE then
		saved = minetest.parse_json(initial_state)
		if type(saved) ~= "table" or #saved ~= COUNT then
			ev("fail=restore-invalid expected=%d", COUNT)
			S.failed = "restore-invalid"
			minetest.request_shutdown()
			return
		end
		S.marks = #minetest.find_nodes_in_area(
			{x = -BOUND, y = 0, z = -BOUND}, {x = BOUND, y = 4, z = BOUND}, {MARK_NODE})
	end
	local cols = math.ceil(math.sqrt(COUNT))
	local offset = -math.floor((cols - 1) * SPACING / 2)
	for i = 0, COUNT - 1 do
		local x = offset + (i % cols) * SPACING
		local z = offset + math.floor(i / cols) * SPACING
		local at = {x = ORIGIN.x + x, y = ORIGIN.y, z = ORIGIN.z + z}
		local obj = minetest.add_entity(at, "society:agent")
		if not obj then
			ev("fail=spawn agent=%d at=%d,%d,%d reason=add_entity-returned-nil", i, at.x, at.y, at.z)
			S.failed = S.failed or "spawn-failed"
		else
			local le = obj:get_luaentity()
			le._id = i
			le._persona = PERSONAS[(i % #PERSONAS) + 1]
			le._home = at
			le._facing = FACINGS[(i % #FACINGS) + 1]
			le._target = nil
			le._rng = (SEED + i * 7919) % 2147483648
			le._decisions = 0
			le._marks_placed = 0
			le._memory = {met = {}, idle_streak = 0}
			le._episodic = cognition_memory.new(32)
			if saved then
				local ok, detail = pcall(persistence.restore, le, saved[i + 1], {reset_minds = RESET_MINDS})
				if not ok or le._id ~= i then
					local state = saved[i + 1] or {}
					ev("fail=restore-invalid agent=%d detail=%s saved_id=%s met_type=%s episodes_type=%s", i,
						tostring(detail):gsub("%s+", "_"), tostring(state.id),
						type(state.memory and state.memory.met), type(state.episodic))
					S.failed = "restore-invalid"
					minetest.request_shutdown()
					return
				end
				if RESET_MINDS then
					le._persona = "new-" .. PERSONAS[(i % #PERSONAS) + 1]
					le._decisions = 0
				end
				ev("ev=restore agent=%d reset=%s memories=%d", i, tostring(RESET_MINDS), le._episodic:size())
			end
			le._resources = resources.new(minetest, obj, le._restored_inventory)
			if MODEL and not RESTORE then
				local resource_pos = {x = at.x + 1, y = at.y, z = at.z}
				if in_bounds(resource_pos) and minetest.get_node(resource_pos).name == "air" then
					minetest.set_node(resource_pos, {name = "society:resource"})
				end
			end
			agents[i] = le
			S.spawned = S.spawned + 1
		end
	end
	ev("spawn count=%d ok=%d spacing=%d bound=%d", COUNT, S.spawned, SPACING, BOUND)
end

local function summary_and_stop()
	ev("summary spawned=%d alive=%d decisions=%d rounds=%d marks=%d meetings=%d actions=%s",
		S.spawned, alive_agents(), S.decisions, S.driver_rounds, S.marks, S.meets, action_string())
	ev("done result=%s reason=%s", S.failed and "fail" or "ok", S.failed or "decisions-reached")
	minetest.request_shutdown()
end

local function fail(reason, fmt, ...)
	S.failed = reason
	ev("fail=" .. reason .. " " .. fmt, ...)
	summary_and_stop()
end

local function verify_spawn()
	local alive = alive_agents()
	ev("check stage=spawn alive=%d expected=%d ok=%s", alive, COUNT, tostring(alive == COUNT))
	if alive ~= COUNT then
		fail("agents-lost-after-spawn",
			"alive=%d expected=%d hint=emerge-race-or-active-block-purge", alive, COUNT)
	end
end

-- 启动序列：forceload -> emerge -> 生成 -> 校验。
-- 顺序不能改：无玩家时区块不被激活，实体不会被 step；而在 emerge 完成前生成，
-- 实体会在活跃区块管理周期里被静默删除，而 add_entity 返回有效对象、不报错。
minetest.after(1, function()
	local lo, hi = math.floor(-BOUND / 16), math.floor(BOUND / 16)
	local ok, tried = 0, 0
	for bx = lo, hi do
		for bz = lo, hi do
			tried = tried + 1
			if minetest.forceload_block({x = bx, y = 0, z = bz}, true, -1) then
				ok = ok + 1
			end
		end
	end
	ev("forceload blocks=%d/%d bound=%d", ok, tried, BOUND)

	minetest.emerge_area({x = -BOUND, y = 0, z = -BOUND}, {x = BOUND, y = 16, z = BOUND},
		function(blockpos, action, calls_remaining)
			if calls_remaining == 0 then
				spawn_agents()
				minetest.after(1, verify_spawn)
			end
		end)
end)

local driver_acc, stats_acc = 0, 0
local step_count, last_us = 0, minetest.get_us_time()

local function emit_stats()
	local now = minetest.get_us_time()
	local secs = (now - last_us) / 1e6
	if secs <= 0 then
		return
	end
	local stepped = 0
	for i = 0, COUNT - 1 do
		local le = agents[i]
		local n = le and le._steps or 0
		if n > (live[i] or 0) then
			stepped = stepped + 1
		end
		live[i] = n
	end
	local alive = alive_agents()
	ev("stats t=%.1f agents=%d/%d stepped_delta=%d steps_per_sec=%.2f decisions=%d marks=%d meetings=%d actions=%s",
		math.floor(minetest.get_gametime() or -1), alive, COUNT, stepped,
		step_count / secs, S.decisions, S.marks, S.meets, action_string())
	step_count, last_us = 0, now

	if alive ~= COUNT then
		-- 存活数掉了就是硬失败：这正是「静默删除」那类坑的表现
		fail("agents-lost", "alive=%d expected=%d hint=active-block-purge", alive, COUNT)
	end
end

minetest.register_globalstep(function(dtime)
	step_count = step_count + 1
	if S.finished or S.failed or S.spawned == 0 then
		return
	end

	driver_acc = driver_acc + dtime
	local rounds = 0
	while driver_acc >= INTERVAL do
		driver_acc = driver_acc - INTERVAL
		rounds = rounds + 1
		if rounds > 5 then
			-- 服务端停顿时不做追赶式补决策，否则事件数不再对应真实时间
			driver_acc = 0
			break
		end
		S.driver_rounds = S.driver_rounds + 1
		for i = 0, COUNT - 1 do
			local le = agents[i]
			if le and le.object and le.object:get_pos() and (MAX_DECISIONS <= 0 or le._decisions < MAX_DECISIONS) then
				decide_and_act(le)
			end
		end
		if MAX_DECISIONS > 0 then
			local done = true
			for i = 0, COUNT - 1 do
				local le = agents[i]
				if not le or (le._decisions or 0) < MAX_DECISIONS then
					done = false
					break
				end
			end
			if done then
				S.finished = true
				summary_and_stop()
				return
			end
		end
	end

	stats_acc = stats_acc + dtime
	if stats_acc >= STATS_EVERY then
		stats_acc = 0
		emit_stats()
	end
end)

-- 被外部 SIGTERM 停掉时也要留下完整账，否则「启停」只测了成功路径。
minetest.register_on_shutdown(function()
	if PERSIST and not S.failed then
		local saved = {}
		for i = 0, COUNT - 1 do
			local ok, snapshot = pcall(persistence.snapshot, agents[i])
			if not ok or not snapshot then
				ev("fail=persist agent=%d", i)
				return
			end
			saved[#saved + 1] = snapshot
		end
		storage:set_string("agent_state", minetest.write_json(saved))
		ev("persist agents=%d", #saved)
	end
	-- 计数器是 mod 自己的账，不是世界的账。这里回读地图核对一次：
	-- 「世界真的变了」必须由世界本身证明，而不是由我们的变量证明。
	local in_world = #minetest.find_nodes_in_area(
		{x = -BOUND, y = 0, z = -BOUND}, {x = BOUND, y = 4, z = BOUND}, {MARK_NODE})
	ev("verify marks_counter=%d marks_in_world=%d ok=%s",
		S.marks, in_world, tostring(S.marks == in_world))
	ev("shutdown alive=%d spawned=%d decisions=%d rounds=%d marks=%d meetings=%d actions=%s",
		alive_agents(), S.spawned, S.decisions, S.driver_rounds, S.marks, S.meets, action_string())
end)

local function sha256_file(path)
	local f = io.open(path, "rb")
	if not f then
		return "unreadable"
	end
	local data = f:read("*a")
	f:close()
	return minetest.sha256(data)
end

-- 产物哈希：行为数字必须能对应到具体的引擎与具体的 mod 源码。
minetest.after(0, function()
	local mp = minetest.get_modpath("society")
	local v = minetest.get_version()
	ev("banner engine=\"%s %s\" proto=%s..%s lua=%s mod=society policy=%s",
		v.project, v.string, tostring(v.proto_min), tostring(v.proto_max),
		jit and jit.version or "lua", policy.version)
	ev("banner count=%d interval=%.2f max_decisions=%d seed=%d spacing=%d bound=%d sense=%d step=%d",
		COUNT, INTERVAL, MAX_DECISIONS, SEED, SPACING, BOUND, SENSE, STEP)
	ev("artifact init_sha256=%s policy_sha256=%s",
		sha256_file(mp .. "/init.lua"), sha256_file(mp .. "/policy.lua"))
end)
