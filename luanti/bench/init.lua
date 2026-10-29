-- societybench：Luanti 服务端实体规模基准（一次性核实脚本，非产品代码）
-- 目的：无玩家的纯服务端场景下，测「多少实体还能保住实时 step 率」。
-- 关键前提（实测得出）：必须先 forceload + 等 emerge 回调完成，再 add_entity；
-- 否则实体在 2 秒一次的活跃区块清理中被静默删除。

local COUNT = tonumber(minetest.settings:get("societybench_count") or "20")
local MODE = minetest.settings:get("societybench_mode") or "idle"
local SPACING = 2
local ORIGIN = {x = 0, y = 1, z = 0}
local LIMIT = tonumber(minetest.settings:get("societybench_limit") or "0")

minetest.register_entity("societybench:agent", {
	initial_properties = {
		visual = "cube",
		visual_size = {x = 0.5, y = 0.5, z = 0.5},
		physical = false,
		collide_with_objects = false,
		pointable = false,
		static_save = false,
	},
	on_activate = function(self)
		self._dir = {x = 1, z = 0}
	end,
	on_step = function(self, dtime)
		self._stepped = true
		if MODE == "idle" then
			return
		end
		local p = self.object:get_pos()
		if not p then
			return
		end
		local d = self._dir
		local np = {x = p.x + d.x * dtime * 2, y = p.y, z = p.z + d.z * dtime * 2}
		if math.abs(np.x - ORIGIN.x) > 4 then d.x = -d.x end
		if math.abs(np.z - ORIGIN.z) > 4 then d.z = -d.z end
		self.object:set_pos(np)
		if MODE == "perceive" then
			self._near = #minetest.get_objects_inside_radius(np, 8)
		end
	end,
})

local cols = math.ceil(math.sqrt(COUNT))
local extent = (cols - 1) * SPACING

local function spawn_agents()
	local failed = 0
	for i = 0, COUNT - 1 do
		local x = (i % cols) * SPACING
		local z = math.floor(i / cols) * SPACING
		if not minetest.add_entity({x = ORIGIN.x + x + 0.5, y = ORIGIN.y, z = ORIGIN.z + z + 0.5},
				"societybench:agent") then
			failed = failed + 1
		end
	end
	minetest.log("action", string.format("BENCH spawn count=%d mode=%s failed=%d", COUNT, MODE, failed))
end

local function count_agents()
	local n, stepped = 0, 0
	for _, e in pairs(minetest.luaentities) do
		if e.name == "societybench:agent" then
			n = n + 1
			if e._stepped then
				stepped = stepped + 1
				e._stepped = nil
			end
		end
	end
	return n, stepped
end

minetest.after(2, function()
	local ok, tried = 0, 0
	for bx = 0, math.floor(extent / 16) do
		for bz = 0, math.floor(extent / 16) do
			tried = tried + 1
			if minetest.forceload_block({x = bx, y = 0, z = bz}, true, -1) then
				ok = ok + 1
			end
		end
	end
	minetest.log("action", string.format("BENCH forceload count=%d mode=%s ok=%d/%d cols=%d extent=%d",
		COUNT, MODE, ok, tried, cols, extent))
	-- 等区块真正 emerge 完成再放实体，否则会被活跃区块清理静默删除
	minetest.emerge_area({x = 0, y = 0, z = 0}, {x = extent, y = 15, z = extent},
		function(blockpos, action, calls_remaining)
			if calls_remaining == 0 then
				spawn_agents()
				minetest.after(1, function()
					minetest.log("action", string.format("BENCH verify count=%d mode=%s alive=%d",
						COUNT, MODE, (count_agents())))
				end)
			end
		end)
end)

local steps, last_us = 0, minetest.get_us_time()
minetest.register_globalstep(function()
	steps = steps + 1
	local now = minetest.get_us_time()
	if now - last_us < 5e6 then
		return
	end
	local step_sec = (now - last_us) / 1e6
	local total, stepped = count_agents()
	minetest.log("action", string.format(
		"BENCH sample count=%d mode=%s entities=%d stepped=%d steps_per_sec=%.2f step_ms=%.2f",
		COUNT, MODE, total, stepped, steps / step_sec, 1000 * step_sec / math.max(steps, 1)))
	steps, last_us = 0, now
end)
