-- Wispiva product runtime: stable-order decisions, private cognition, verified actions.
local policy = dofile(minetest.get_modpath("society") .. "/policy.lua")
local cognition_observe = dofile(minetest.get_modpath("society") .. "/observation.lua")
local cognition_memory = dofile(minetest.get_modpath("society") .. "/memory.lua")
local long_term_memory = dofile(minetest.get_modpath("society") .. "/long_term_memory.lua")
local world_events = dofile(minetest.get_modpath("society") .. "/world_events.lua")
local persistence = dofile(minetest.get_modpath("society") .. "/persistence.lua")
local resources = dofile(minetest.get_modpath("society") .. "/resource_actions.lua")
local action_context = dofile(minetest.get_modpath("society") .. "/action_context.lua")
local model_envelope = dofile(minetest.get_modpath("society") .. "/model_envelope.lua")
local spatial = dofile(minetest.get_modpath("society") .. "/spatial.lua")
local node_cache = dofile(minetest.get_modpath("society") .. "/node_cache.lua")
local scheduler = dofile(minetest.get_modpath("society") .. "/scheduler.lua")

local function cfg(name, default)
	return minetest.settings:get(name) or default
end

local WORLD_PRODUCT = cfg("society_world_product", "false") == "true"
local GENESIS_MANIFEST_PATH = cfg("society_genesis_manifest", "")
local product_state_module
if WORLD_PRODUCT then
	product_state_module = dofile(minetest.get_modpath("society") .. "/product_state.lua")
end
local environment_module, world_projection
if WORLD_PRODUCT then
	local modpath = minetest.get_modpath("society")
	environment_module = dofile(modpath .. "/environment.lua")
	world_projection = dofile(modpath .. "/world_projection.lua")
end
local genesis_manifest
if WORLD_PRODUCT then
	assert(GENESIS_MANIFEST_PATH ~= "", "product world requires society_genesis_manifest")
	local file = assert(io.open(GENESIS_MANIFEST_PATH, "rb"), "missing product genesis manifest")
	local raw = file:read(131073); file:close()
	assert(#raw <= 131072, "product genesis manifest too large")
	genesis_manifest = minetest.parse_json(raw)
	assert(type(genesis_manifest) == "table" and genesis_manifest.format == "wispiva-world-manifest"
		and genesis_manifest.version == 1 and type(genesis_manifest.world_id) == "string"
		and type(genesis_manifest.origin_event_id) == "string", "invalid product genesis manifest")
end
local COUNT = WORLD_PRODUCT and #genesis_manifest.actors or tonumber(cfg("society_count", "5"))
local INTERVAL = tonumber(cfg("society_decide_interval", "2.0"))
local MAX_DECISIONS = tonumber(cfg("society_max_decisions", "10"))
local SEED = tonumber(cfg("society_seed", "20261027"))
local SPACING = tonumber(cfg("society_spacing", "8"))
local BOUND = tonumber(cfg("society_bound", "32"))
local WANDER = tonumber(cfg("society_wander_radius", "12"))
local SENSE = tonumber(cfg("society_sense_radius", "12"))
local STEP = tonumber(cfg("society_step", "2"))
local STATS_EVERY = tonumber(cfg("society_stats_interval", "5"))
local OPTIMIZED = cfg("society_optimized", "true") == "true"
local PROFILE = cfg("society_profile", "false") == "true"
local FRAME_BUDGET = tonumber(cfg("society_frame_budget_ms", "65"))
local MEMORY_MODE = cfg("society_memory_mode", "fifo")
local ORIGIN = {x = 0, y = 1, z = 0}
local MARK_NODE = cfg("society_mark_node", "society:mark")
local COGNITION = cfg("society_cognition", "false") == "true"
local VISUAL = cfg("society_visual", "false") == "true"
local MODEL = cfg("society_model", "false") == "true"
local SEED_RESOURCES = cfg("society_seed_resources", "false") == "true"
local MODEL_MEMORY = cfg("society_model_memory", "true") == "true"
local LONG_TERM = cfg("society_long_term_memory", "false") == "true"
local LOG_MESSAGES = cfg("society_log_messages", "false") == "true"
local GOAL = cfg("society_goal", "Explore, gather resources, build, and interact with nearby agents.")
local VIEW_GUIDE = cfg("society_view_guide", "false") == "true"
local VIEW_SPAWN = cfg("society_view_spawn", "false") == "true"
local VIEW_ACCEPTANCE = cfg("society_view_acceptance", "false") == "true"
local VIEW_GUIDE_SPEED = tonumber(cfg("society_view_guide_speed", "1.5"))
local EVENT_NAMESPACE = cfg("society_event_namespace", "default")
assert(type(EVENT_NAMESPACE) == "string" and EVENT_NAMESPACE ~= "" and #EVENT_NAMESPACE <= 128,
	"invalid society_event_namespace")
local PERSIST = cfg("society_persist", "false") == "true"
local RESTORE = cfg("society_restore", "false") == "true"
local RESET_MINDS = cfg("society_reset_minds", "false") == "true"
if WORLD_PRODUCT then
	assert(LONG_TERM, "product world requires society_long_term_memory")
end
local storage = minetest.get_mod_storage()
local initial_state = storage:get_string("agent_state")
local product_state
local product_active_run = false
local offline_seconds = 0
local product_clock_bootstrap = false
local environment_process
local environment_last_time = 0
local function save_product_state()
	assert(WORLD_PRODUCT and product_state, "product state unavailable")
	local encoded = minetest.write_json(product_state:export())
	assert(type(encoded) == "string" and encoded ~= "", "product state encoding failed")
	storage:set_string("product_state", encoded)
	assert(storage:get_string("product_state") == encoded, "product state write/readback failed")
end
local function freeze_product_state(reason)
	if not WORLD_PRODUCT or not product_state then return end
	local ok, frozen = pcall(product_state.freeze, product_state, reason)
	if ok then
		local encoded = minetest.write_json(frozen)
		local written = pcall(storage.set_string, storage, "product_state", encoded)
		if not written or storage:get_string("product_state") ~= encoded then
			minetest.log("error", "SOCIETY product-world freeze-write-failed reason=" .. tostring(reason):gsub("%s+", "_"))
		else
			minetest.log("error", "SOCIETY product-world frozen reason=" .. tostring(reason):gsub("%s+", "_"))
		end
	else
		minetest.log("error", "SOCIETY product-world freeze-failed reason=" .. tostring(reason):gsub("%s+", "_")
			.. " error=" .. tostring(frozen):gsub("%s+", "_"))
	end
end
local function set_product_clock(engine_time, wall_time)
	if not WORLD_PRODUCT or not product_state then return end
	local existing = product_state:clock()
	product_state:set_clock({version=1, logical_time=environment_last_time,
		engine_time=math.max(0, math.floor(engine_time or 0)),
		saved_wall_time=existing and existing.saved_wall_time or math.max(0, math.floor(wall_time or os.time()))})
end
if WORLD_PRODUCT then
	local raw_state = storage:get_string("product_state")
	if raw_state == "" then
		product_state = product_state_module.new(genesis_manifest.world_id, genesis_manifest.origin_event_id)
		save_product_state()
	else
		local decoded = minetest.parse_json(raw_state)
		local ok, loaded = pcall(product_state_module.load, decoded)
		assert(ok, "invalid persisted product state")
		product_state = loaded
	end
	assert(product_state:phase() == "READY", "product world is frozen or has an unfinished commit")
	assert(storage:get_string("product_active_run") == "", "previous product run ended without a committed checkpoint")
	product_active_run = true
	storage:set_string("product_active_run", EVENT_NAMESPACE)
	assert(storage:get_string("product_active_run") == EVENT_NAMESPACE, "product active marker write failed")
end
local GENESIS_PREVIEW = cfg("society_genesis_preview", "false") == "true"
assert(not (WORLD_PRODUCT and GENESIS_PREVIEW), "product world cannot be disposable preview")
local preview_module, preview_actors
if GENESIS_PREVIEW then
    assert(not PERSIST and not RESTORE and not LONG_TERM and MODEL and COGNITION and not LOG_MESSAGES and BOUND == 32 and initial_state == "", "preview requires a fresh isolated nonpersistent world")
    preview_module = dofile(minetest.get_modpath("society") .. "/genesis_preview.lua")
    local file = assert(io.open(cfg("society_genesis_private_manifest", ""), "rb"), "missing preview manifest")
    local raw = file:read(32769); file:close()
    assert(#raw <= 32768, "preview manifest too large")
    preview_actors = preview_module.validate(minetest.parse_json(raw), COUNT)
end
local SPOOL = cfg("society_spool", "")
local request_id = 0
local step_count, last_us = 0, minetest.get_us_time()

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

local view_landmarks, view_route = {}, {}
local view_guide, view_route_index = nil, 1
local view_route_seen, view_players = {}, {}

local summary_and_stop
local ev, fail
local agents = {}
local history = long_term_memory.new()
local event_log = world_events.new()
if WORLD_PRODUCT then
	local raw = storage:get_string("environment_state")
	if raw ~= "" then
		local decoded = minetest.parse_json(raw)
		local ok, loaded = pcall(environment_module.load, decoded)
		assert(ok, "invalid persisted environment state")
		environment_process = loaded
		environment_last_time = loaded:export().time
	else
		environment_process = environment_module.new({id="world-resource", resource="society:resource",
			capacity=16, amount=2, rate=1, time=0})
	end
	local components = product_state:components()
	if components.actors > 0 or components.inventory > 0 or components.events > 0 or components.memory > 0 then
		assert(initial_state ~= "", "product checkpoint is missing while committed state is present")
	end
	if components.environment > 0 then
		assert(raw ~= "", "product environment checkpoint is missing while committed state is present")
	end
	local clock = product_state:clock()
	if not clock then
		local committed = components.map > 0 or components.actors > 0 or components.inventory > 0
			or components.events > 0 or components.memory > 0 or components.environment > 0
		if committed then
			freeze_product_state("committed product state is missing logical clock")
			error("committed product state is missing logical clock")
		end
		set_product_clock(environment_last_time, minetest.get_gametime())
		product_clock_bootstrap = true
		save_product_state()
	else
		if clock.logical_time ~= environment_last_time then
			freeze_product_state("logical clock differs from environment checkpoint")
			error("logical clock differs from environment checkpoint")
		end
		offline_seconds = math.max(0, math.floor(os.time()) - clock.saved_wall_time)
	end
end
local live = {}          -- 上一次统计时每个 agent 的 _steps 快照
local resource_initial = nil
local index = spatial.new(math.max(SENSE, 1))
local cached_nodes = node_cache.new(minetest, {MARK_NODE, "society:resource"}, 16, 1024)
local object_queries = 0
local profile = {observe=0, action=0, contact=0, callback=0, max_callback=0, log=0}
local run_started
local cadence = {sum=0, min=math.huge, max=0, n=0}
local frame_driver
local function nearby(pos, radius)
	object_queries = object_queries + 1
	local objects = OPTIMIZED and index:query(pos, radius) or minetest.get_objects_inside_radius(pos, radius)
	-- Tie breaking is independent of engine iteration order on both sides.
	if not OPTIMIZED then
		table.sort(objects, function(a,b)
			local ae, be = a:get_luaentity(), b:get_luaentity()
			return (ae and ae._id or -1) < (be and be._id or -1)
		end)
	end
	return objects
end

-- Long-term retrieval is durable but bounded by its own owner index. Episodic
-- memory is the actor's private recent fallback, especially across restore
-- when an older experience may fall outside the long-term page. Merge only
-- the current actor's two projections; never source memory from another id.
local function merge_private_memory(long_term, episodic, max_entries, max_bytes)
	local result, seen, bytes = {}, {}, 2
	local function key(entry)
		if entry.id ~= nil then return "id:" .. tostring(entry.id) end
		local source = entry.source or {}
		return "source:" .. tostring(source.kind) .. ":" .. tostring(source.id)
			.. ":" .. tostring(entry.text)
	end
	local function cost(entry)
		-- cognition_memory.serialize includes all public memory metadata except
		-- the long-term row id; reserve a small conservative allowance for it.
		return #cognition_memory.serialize({entry}) + (entry.id and #tostring(entry.id) + 16 or 0)
	end
	local function add(entry)
		local identity = key(entry)
		if seen[identity] then return end
		local extra = cost(entry) + (#result > 0 and 1 or 0)
		if #result >= max_entries or bytes + extra > max_bytes then return end
		seen[identity] = true
		result[#result + 1] = entry
		bytes = bytes + extra
	end
	-- Recent private episodic entries get the first opportunity; durable
	-- retrieval fills the remaining bounded context without changing access.
	for _, entry in ipairs(episodic or {}) do add(entry) end
	for _, entry in ipairs(long_term or {}) do add(entry) end
	return result, {entries = #result, byte_bound = bytes, merged = true}
end
local function find_nodes(lo, hi, names)
	if OPTIMIZED then return cached_nodes:find(lo, hi, names) end
	return minetest.find_nodes_in_area(lo, hi, names)
end
local observation_engine = {
	get_objects_inside_radius = nearby,
	find_nodes_in_area = find_nodes,
	get_node_or_nil = minetest.get_node_or_nil,
}

local function resource_total()
	local in_world = #minetest.find_nodes_in_area(
		{x = -BOUND, y = 0, z = -BOUND}, {x = BOUND, y = 4, z = BOUND}, {"society:resource"})
	local inventory = 0
	for i = 0, COUNT - 1 do
		local le = agents[i]
		if le and le._resources then inventory = inventory + le._resources:count("society:resource") end
	end
	return in_world, inventory
end

ev = function(fmt, ...)
	local started = PROFILE and minetest.get_us_time()
	minetest.log("action", "SOCIETY " .. string.format(fmt, ...))
	if started then profile.log = profile.log + minetest.get_us_time()-started end
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

local function view_send(player, message)
	if player and player:is_player() then
		minetest.chat_send_player(player:get_player_name(), "[Wispiva] " .. message)
	end
end

local function view_interact(landmark, player, source)
	local place = landmark and landmark._place_name or "this place"
	local description = landmark and landmark._place_description or "A place in the world."
	local player_name = player and player:is_player() and player:get_player_name() or "fixture"
	view_send(player, place .. ": " .. description)
	if landmark then
		landmark.object:set_properties({nametag = place .. "\nRead: " .. description})
	end
	ev("view interaction player=%s place=%s source=%s", player_name, tostring(landmark and landmark._place_id or "unknown"), source or "player")
end

minetest.register_entity("society:view_landmark", {
		initial_properties = {
			visual = "cube",
			visual_size = {x = 0.8, y = 1.2},
			textures = {"default_stone.png^[colorize:#d39b4a:180"},
			physical = false,
			collide_with_objects = false,
			pointable = true,
			static_save = false,
		},
		on_rightclick = function(self, clicker)
			view_interact(self, clicker, "player")
		end,
	})

minetest.register_entity("society:view_guide", {
		initial_properties = {
			visual = "cube",
			visual_size = {x = 0.7, y = 1.4},
			textures = {"default_stone.png^[colorize:#63b4d8:180"},
			physical = false,
			collide_with_objects = false,
			pointable = true,
			static_save = false,
			nametag = "Wispiva guide\nFollow the route",
			nametag_color = "#ffffff",
		},
		on_rightclick = function(self, clicker)
			view_send(clicker, "Follow the guide to each named place, then right-click a landmark to inspect it.")
			ev("view guide-interaction player=%s", clicker and clicker:get_player_name() or "fixture")
		end,
	})

local function view_landmark_position(place)
	local radius = place.space == "indoor" and 3 or 2
	return {x = place.anchor.x + radius + 1, y = 1.5, z = place.anchor.z}
end

local function spawn_view_scene()
	if not WORLD_PRODUCT or not VIEW_GUIDE then return end
	local places = {}
	for _, place in ipairs(genesis_manifest.public.places or {}) do places[#places + 1] = place end
	table.sort(places, function(a, b) return a.id < b.id end)
	for index, place in ipairs(places) do
		local position = view_landmark_position(place)
		local object = minetest.add_entity(position, "society:view_landmark")
		if not object then
			fail("view-scene", "landmark=%s reason=add_entity-returned-nil", place.id)
			return
		end
		local landmark = object:get_luaentity()
		landmark._place_id = place.id
		landmark._place_name = place.name
		landmark._place_description = place.description or ("The " .. place.name .. " area.")
		local colors = {"#d39b4a", "#8fc477", "#b58ad9", "#d87878", "#6fa9d8"}
		object:set_properties({
			textures = {"default_stone.png^[colorize:" .. colors[((index - 1) % #colors) + 1] .. ":180"},
			nametag = place.name .. "\nRight-click to inspect",
			nametag_color = "#ffffff",
		})
		view_landmarks[place.id] = landmark
		view_route[#view_route + 1] = {id = place.id, position = position, name = place.name}
	end
	if #view_route == 0 then
		fail("view-scene", "reason=no-public-places")
		return
	end
	view_guide = minetest.add_entity({x = 0, y = 1.5, z = -16}, "society:view_guide")
	if not view_guide then
		fail("view-scene", "guide=missing")
		return
	end
	ev("view scene-ready places=%d observer_spawn=0,2,-20 interaction=landmark-rightclick", #view_route)
	if VIEW_ACCEPTANCE then
		minetest.after(2, function()
			local players = minetest.get_connected_players()
			if #players > 0 then view_interact(view_landmarks[view_route[1].id], players[1], "fixture") end
		end)
	end
end

local function update_view_scene(dtime)
	if not view_guide or #view_route == 0 then return end
	local entity = view_guide:get_luaentity()
	local current = view_guide:get_pos()
	if not entity or not current then return end
	local target = view_route[view_route_index]
	local dx, dz = target.position.x - current.x, target.position.z - current.z
	local distance = math.sqrt(dx * dx + dz * dz)
	if distance <= 0.15 then
		if not view_route_seen[target.id] then
			view_route_seen[target.id] = true
			ev("view guide-arrival place=%s", target.id)
		end
		view_guide:set_properties({nametag = "Wispiva guide\nAt " .. target.name})
		if view_route_index < #view_route then view_route_index = view_route_index + 1 else return end
		return
	end
	local step = math.min(distance, math.max(VIEW_GUIDE_SPEED, 0.1) * dtime)
	view_guide:set_pos({x = current.x + dx / distance * step, y = current.y, z = current.z + dz / distance * step})
end

local function update_view_players()
	if not VIEW_GUIDE then return end
	for _, player in ipairs(minetest.get_connected_players()) do
		local name, position = player:get_player_name(), player:get_pos()
		local prior = view_players[name]
		if position and prior then
			local dx, dz = position.x - prior.x, position.z - prior.z
			if not view_players[name].moved and dx * dx + dz * dz >= 1 then
				view_players[name].moved = true
				view_send(player, "You moved through the scene. Look for the named landmark and the guide.")
				ev("view movement player=%s", name)
			end
		end
		if position then view_players[name] = {x = position.x, z = position.z, moved = prior and prior.moved or false} end
	end
end

if minetest.register_on_joinplayer then
	minetest.register_on_joinplayer(function(player)
		if not VIEW_GUIDE then return end
		if VIEW_SPAWN then player:set_pos({x = 0, y = 2, z = -20}) end
		local name = player:get_player_name()
		view_players[name] = nil
		view_send(player, "Welcome. Move with WASD, look around, and right-click a named landmark for feedback.")
		ev("view join player=%s", name)
	end)
end

if minetest.register_on_leaveplayer then
	minetest.register_on_leaveplayer(function(player)
		view_players[player:get_player_name()] = nil
	end)
end

-- 确定性 PRNG：每个 agent 一份状态，种子固定。
-- 不用 math.random，因为它受引擎与调用顺序影响，两次运行不一定给出同一序列。
local function rng_next(self, n)
	self._rng = (self._rng * 1103515245 + 12345) % 2147483648
	return self._rng % n
end

local function observe(self, pos)
	local nearby_agents = {}
	local nearest, nearest_d = nil, nil
	local candidates = nearby(pos, SENSE)
	for _, obj in ipairs(candidates) do
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

	local marks = #find_nodes(
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
	}, candidates
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
	if OPTIMIZED then index:upsert(self._id, self.object, np) end
	return np
end

local function apply(self, action, pos)
	local kind = action.kind or "unknown"
	if VISUAL then
		local labels = {advance="Walking", approach="Approaching another agent", inspect="Looking around",
			mark="Placing a marker", wander="Choosing a destination", say="Sending a message",
			gather="Gathering", build="Building"}
		self.object:set_properties({nametag = self._persona .. "\n" .. (labels[kind] or kind)})
	end
	S.actions[kind] = (S.actions[kind] or 0) + 1

	if GENESIS_PREVIEW and (kind == "mark" or kind == "gather" or kind == "build") then
		ev("ev=preview-action-rejected agent=%d action=%s reason=world-write-unsupported", self._id, kind)
		return false, "preview-world-write-unsupported"
	end

	if kind == "advance" then
		local np = step_toward(self, pos, self._target)
		if not np then
			ev("ev=target-dropped agent=%d persona=%s reason=out-of-bounds", self._id, self._persona)
			self._target = nil
			return false, "out-of-bounds"
		end
		local d = math.max(math.abs(self._target.x - np.x), math.abs(self._target.z - np.z))
		ev("ev=move agent=%d persona=%s to=%d,%d,%d remaining=%d why=%s",
			self._id, self._persona, np.x, np.y, np.z, d, action.why or "-")
		if d <= STEP then
			self._target = nil
			ev("ev=arrive agent=%d persona=%s at=%d,%d,%d", self._id, self._persona, np.x, np.y, np.z)
		end
		return true, "moved"
	end

	if kind == "wander" then
		local p = action.point
		self._target = {x = fp(p.x), y = fp(p.y), z = fp(p.z)}
		ev("ev=wander agent=%d persona=%s why=%s target=%d,%d,%d",
			self._id, self._persona, action.why or "-", self._target.x, self._target.y, self._target.z)
		self._memory.idle_streak = 0
		return true, "destination-set"
	end

	if kind == "approach" then
		local le = agents[action.target]
		local tp = le and le.object and le.object:get_pos()
		if not tp then
			ev("ev=approach-failed agent=%d persona=%s target=%s reason=gone",
				self._id, self._persona, tostring(action.target))
			self._memory.idle_streak = self._memory.idle_streak + 1
			return false, "gone"
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
		return true, "destination-set"
	end

	if kind == "mark" then
		local f = self._facing
		local at = {x = fp(pos.x) + f.x, y = fp(pos.y), z = fp(pos.z) + f.z}
		if not in_bounds(at) then
			ev("ev=mark-skipped agent=%d persona=%s at=%d,%d,%d reason=out-of-bounds",
				self._id, self._persona, at.x, at.y, at.z)
			self._memory.idle_streak = self._memory.idle_streak + 1
			return false, "out-of-bounds"
		end
		local before = minetest.get_node(at).name
		if before ~= "air" then
			-- 位置已被占（别的 agent 或地图本身）：不能假装成功
			ev("ev=mark-skipped agent=%d persona=%s at=%d,%d,%d reason=occupied by=%s",
				self._id, self._persona, at.x, at.y, at.z, before)
			self._memory.idle_streak = self._memory.idle_streak + 1
			return false, "occupied"
		end
		minetest.set_node(at, {name = MARK_NODE})
		cached_nodes:invalidate(at)
		local after = minetest.get_node(at).name
		if after ~= MARK_NODE then
			-- 写了但没落地：必须报出来，不能计入成功
			ev("ev=mark-failed agent=%d persona=%s at=%d,%d,%d after=%s",
				self._id, self._persona, at.x, at.y, at.z, after)
			self._memory.idle_streak = self._memory.idle_streak + 1
			return false, "write-not-verified"
		end
		S.marks = S.marks + 1
		self._marks_placed = self._marks_placed + 1
		ev("ev=mark agent=%d persona=%s at=%d,%d,%d marks_total=%d",
			self._id, self._persona, at.x, at.y, at.z, S.marks)
		self._memory.idle_streak = 0
		return true, "world-verified"
	end

	if kind == "inspect" then
		self._memory.idle_streak = self._memory.idle_streak + 1
		ev("ev=inspect agent=%d persona=%s at=%d,%d,%d neighbours=%d marks_nearby=%d",
			self._id, self._persona, fp(pos.x), fp(pos.y), fp(pos.z),
			#action.observation.nearby_agents, action.observation.marks_nearby)
		return true, "observed"
	end

	if kind == "gather" or kind == "build" then
		local ok, reason = self._resources[kind](self._resources, action.point, "society:resource")
		reason = reason or (ok and "world-verified" or "action-failed")
		cached_nodes:invalidate(action.point)
		self._last_action = {kind = kind, point = action.point, ok = ok, reason = reason}
		self._episodic:add({time = minetest.get_gametime(),
			text = string.format("%s at %d,%d,%d %s: %s; inventory=%d", kind,
				action.point.x, action.point.y, action.point.z, ok and "succeeded" or "failed",
				reason, self._resources:count("society:resource")),
			source = {kind = "action", id = self._id}})
		ev("ev=resource agent=%d action=%s ok=%s reason=%s inventory=%d", self._id, kind,
			tostring(ok), tostring(reason or "none"):gsub("%s+", "_"), self._resources:count("society:resource"))
		return ok, reason
	end
	if kind == "say" then
		local recipient = agents[action.target]
		if GENESIS_PREVIEW then
			local ok, reason = preview_module.deliver(self, recipient, action.text, minetest.get_gametime())
			if ok then
				if VISUAL then self.object:set_properties({nametag=self._persona .. "\n" .. action.text}) end
				ev("ev=message agent=%d recipient=%d sha256=%s", self._id, action.target, minetest.sha256(action.text))
			end
			return ok, reason
		end
		if recipient and recipient.object and recipient.object:get_pos() then
			local message_id = string.format("%s:message:%d:%d", EVENT_NAMESPACE, self._id, self._decisions + 1)
			recipient._inbox[#recipient._inbox + 1] = {time = minetest.get_gametime(),
				from = self._id, text = action.text, message_id = message_id}
			if #recipient._inbox > 32 then table.remove(recipient._inbox, 1) end
			recipient._episodic:add({time = minetest.get_gametime(), text = action.text,
				source = {kind = "agent", id = tostring(self._id)}})
			self._episodic:add({time = minetest.get_gametime(), text = action.text,
				source = {kind = "self", id = tostring(self._id)}})
			if VISUAL then self.object:set_properties({nametag = self._persona .. "\n" .. action.text}) end
			ev("ev=message agent=%d recipient=%d sha256=%s", self._id, action.target,
				minetest.sha256(action.text))
			if LOG_MESSAGES then
				ev("ev=message-text agent=%d recipient=%d text=%s", self._id, action.target,
					minetest.write_json(action.text):gsub("[\r\n]", ""))
			end
			return true, "delivered"
		end
		return false, "recipient-gone"
	end
	self._memory.idle_streak = self._memory.idle_streak + 1
	ev("ev=unknown-action agent=%d persona=%s kind=%s", self._id, self._persona, kind)
	return false, "unknown-action"
end

-- 走到邻居身边时记一次接触：这不是决策，是执行结果反馈进记忆。
local function settle_contacts(self, pos)
	for _, obj in ipairs(nearby(pos, STEP + 1)) do
		if obj ~= self.object then
			local le = obj:get_luaentity()
			if le and le.name == "society:agent" and le._id and le._memory
					and not self._memory.met[le._id] then
				local operation_id = string.format("%s:contact:%d:%d", EVENT_NAMESPACE,
					math.min(self._id, le._id), math.max(self._id, le._id))
				local committed, event = pcall(event_log.commit, event_log, operation_id, {
					time = minetest.get_gametime(), kind = "meet", actor = tostring(self._id),
					ok = true, reason = "contact", participants = {tostring(le._id)},
				})
				if not committed then
					ev("fail=world-event agent=%d detail=%s", self._id, tostring(event):gsub("%s+", "_"))
					S.failed = "world-event"
					summary_and_stop()
					return
				end
				if LONG_TERM then
					local ok, detail = pcall(history.record_meeting, history, tostring(self._id), tostring(le._id), minetest.get_gametime(), event.id)
					if not ok then
						ev("fail=long-term-record agent=%d detail=%s", self._id, tostring(detail):gsub("%s+", "_"))
						S.failed = "long-term-record"
						summary_and_stop()
						return
					end
				end
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
	local raw_pos = pos
	pos = {x = fp(pos.x), y = fp(pos.y), z = fp(pos.z)}

	local measured = PROFILE and minetest.get_us_time()
	local obs, candidates = observe(self, pos)
	if COGNITION and not self._pending then
		local shared_engine = observation_engine
		if OPTIMIZED and raw_pos.x==pos.x and raw_pos.y==pos.y and raw_pos.z==pos.z then
			shared_engine = {get_objects_inside_radius=function() return candidates end,
				find_nodes_in_area=find_nodes, get_node_or_nil=minetest.get_node_or_nil}
		end
		local local_obs, err = cognition_observe.observe(shared_engine, self.object,
			{radius = SENSE, node_names = {MARK_NODE, "society:resource"}})
		if not local_obs then
			ev("fail=observation agent=%d reason=%s", self._id, err)
			S.failed = "observation"
			summary_and_stop()
			return
		end
		local marks, resource_count = 0, 0
		for _, node in ipairs(local_obs.nodes) do
			if node.name == MARK_NODE then marks = marks + 1 end
			if node.name == "society:resource" then resource_count = resource_count + 1 end
		end
		self._episodic:add({time = minetest.get_gametime(),
			text = string.format("nearby agents=%d marks=%d resources=%d", #local_obs.agents, marks, resource_count),
			source = {kind = "observation", id = self._id}})
		obs.local_view = local_obs
	end
	if measured then profile.observe = profile.observe + minetest.get_us_time() - measured end
	local action
	if MODEL then
		if not self._pending then
			request_id = request_id + 1
			local query_parts = {(GENESIS_PREVIEW or WORLD_PRODUCT) and self._genesis.goal or GOAL}
			if WORLD_PRODUCT then
				query_parts[#query_parts + 1] = "role " .. self._genesis.role
				for _, seed in ipairs(self._genesis.memory_seeds or {}) do
					query_parts[#query_parts + 1] = "private memory " .. seed.text
				end
			end
			if self._last_action then query_parts[#query_parts+1] = minetest.write_json(self._last_action) end
			for _, id in ipairs(obs.nearby_agents) do query_parts[#query_parts+1] = "agent " .. id end
			for _, node in ipairs(obs.local_view and obs.local_view.nodes or {}) do
				query_parts[#query_parts+1] = node.name
			end
			local memory_query = table.concat(query_parts, " ")
			local selected_memory, memory_info
			if MODEL_MEMORY and LONG_TERM then
				local latest = self._inbox[#self._inbox]
				local query = latest and latest.text or ""
				local durable_memory, durable_info = history:retrieve(tostring(self._id),
					{query=query, max_scan=256, max_entries=8, max_bytes=4096})
				local episodic_memory = self._episodic:select(memory_query,
					{strategy="fifo", max_entries=8, max_chars=4096})
				selected_memory, memory_info = merge_private_memory(durable_memory, episodic_memory, 8, 4096)
				memory_info.query = query
				memory_info.durable = durable_info
			elseif MODEL_MEMORY then
				selected_memory = self._episodic:select(memory_query,
					{strategy=MEMORY_MODE, max_entries=8, max_chars=4096})
			else selected_memory = {} end
			local context = {observation = {has_target = obs.has_target,
				nearby_agents = obs.nearby_agents, pos = obs.pos, marks_nearby = obs.marks_nearby},
				self_id = self._id, time = minetest.get_gametime(), persona = self._persona,
				goal = (GENESIS_PREVIEW or WORLD_PRODUCT) and self._genesis.goal or GOAL,
				nearby_positions = obs.local_view and obs.local_view.agents or {},
				movement_target = self._target,
				last_action = self._last_action, incoming_messages = self._inbox,
				visible_nodes = obs.local_view and obs.local_view.nodes or {},
				inventory = self._resources:inventory(),
				memory_query = memory_query,
				memory = selected_memory, memory_scope = memory_info,
				bounds = {min = {x = -BOUND, y = pos.y, z = -BOUND},
					max = {x = BOUND, y = pos.y, z = BOUND}}}
			if GENESIS_PREVIEW then preview_module.attach_context(context, self._genesis) end
			if WORLD_PRODUCT then
				context.origin = {format = "wispiva-world-manifest", version = 1,
					world_id = genesis_manifest.world_id,
					origin_event_id = genesis_manifest.origin_event_id,
					actor_id = self._genesis.actor_id,
					private_memory_count = #(self._genesis.memory_seeds or {})}
				context.genesis_profile = {actor_id = self._genesis.actor_id,
					role = self._genesis.role, goal = self._genesis.goal,
					memory_seeds = self._genesis.memory_seeds or {}}
			end
			context.local_actions = action_context.describe(minetest, pos,
				context.visible_nodes, context.inventory, context.bounds)
			if WORLD_PRODUCT then
				local facts, experiences, rumors, unknowns = {}, {}, {}, {}
				local seed_ids, knowledge_ids = {}, {}
				for _, seed in ipairs(self._genesis.memory_seeds or {}) do seed_ids[seed.seed_id] = true end
				local function add_unique(list, record)
					if not knowledge_ids[record.id] then
						knowledge_ids[record.id] = true
						list[#list + 1] = record
					end
				end
				for _, node in ipairs(context.visible_nodes or {}) do
					add_unique(facts, {id = string.format("observation:%s:%d:%d:%d", self._id,
						fp(node.pos.x), fp(node.pos.y), fp(node.pos.z)),
						text = "I can currently observe " .. node.name .. " nearby.",
						source = {kind = "engine.sensor", id = "observation:" .. tostring(self._id)},
						scope = "public", audience = {self._genesis.actor_id}, captured_at = minetest.get_gametime()})
				end
				for _, memory in ipairs(selected_memory or {}) do
					if not seed_ids[memory.id] then
						local kind = memory.classification == "rumor" and "rumor"
							or (memory.classification == "unknown" and "unknown" or "experience")
						local source = memory.source or {}
						local memory_id = memory.id or string.format("episodic:%s:%s:%s",
							tostring(source.kind), tostring(source.id), tostring(memory.time))
						-- Legacy episodic checkpoints may contain numeric runtime IDs.
						-- The provider-facing envelope has a textual provenance contract;
						-- normalize this boundary without rewriting restored history.
						local envelope_source = {kind = source.kind, id = tostring(source.id),
							revision = source.revision}
						local record = {id = memory_id, text = memory.text, source = envelope_source,
							captured_at = memory.time, scope = "private", audience = {self._genesis.actor_id}}
						if kind == "rumor" then add_unique(rumors, record)
						elseif kind == "unknown" then add_unique(unknowns, record)
						else add_unique(experiences, record) end
					end
				end
				for _, seed in ipairs(self._genesis.memory_seeds or {}) do
					add_unique(unknowns, {id = seed.seed_id, text = seed.text,
						source = {kind = "genesis_seed", id = genesis_manifest.origin_event_id},
						scope = "private", audience = {self._genesis.actor_id}, captured_at = nil})
				end
				for index, message in ipairs(self._inbox or {}) do
					add_unique(rumors, {id = message.message_id or string.format("message:%s:%d", tostring(message.from), index),
						text = message.text, source = {kind = "agent_message", id = message.message_id or tostring(message.from)},
						scope = "private", audience = {self._genesis.actor_id}, captured_at = message.time})
				end
				local feedback = {available = false}
				if self._last_action then
					feedback = {available = true, attempt_id = self._last_action.attempt_id,
						requested = {kind = self._last_action.kind, point = self._last_action.point},
						status = self._last_action.ok and "succeeded" or "failed", reason = self._last_action.reason,
						event_id = self._last_action.event_id, observed_at = minetest.get_gametime(),
						world_revision = self._last_action.world_revision}
				end
				local envelope = model_envelope.build({world_id = genesis_manifest.world_id,
					origin_event_id = genesis_manifest.origin_event_id, actor_id = self._genesis.actor_id,
					runtime_id = self._id, decision_id = EVENT_NAMESPACE .. ":agent:" .. tostring(self._id) .. ":decision:" .. tostring(self._decisions + 1),
					world_revision = product_state:version(), observed_at = minetest.get_gametime(),
					actor = {name = self._genesis.name, role = self._genesis.role, goal = self._genesis.goal,
						role_source = {kind = "genesis.actor", id = genesis_manifest.origin_event_id .. ":" .. self._genesis.actor_id},
						goal_source = {kind = "genesis.goal", id = genesis_manifest.origin_event_id .. ":" .. self._genesis.actor_id}},
					permissions = {read_scopes = {"world.public", "self.experience", "self.memory", "direct.messages"},
						allowed_actions = {"inspect", "wander", "advance", "approach", "say", "gather", "build"}},
					facts = facts, experiences = experiences, rumors = rumors, unknowns = unknowns,
					observation = context.observation, inventory = context.inventory,
					affordances = context.local_actions, feedback = feedback})
				model_envelope.validate(envelope)
				context.model_input = envelope
			end
			if GENESIS_PREVIEW then context.preview_unsupported_actions = {"mark", "gather", "build"} end
			local path = SPOOL .. "/request-" .. request_id .. ".json"
			local encoded = string.format('{"id":%d,"context":%s}', request_id, minetest.write_json(context))
			if not minetest.safe_file_write(path, encoded) then
				ev("fail=model-request-write agent=%d", self._id)
				S.failed = "model-request-write"
				summary_and_stop()
				return
			end
			self._pending = {id = request_id, started = minetest.get_us_time()}
			self._inbox = {}
			ev("ev=model-request agent=%d request=%d", self._id, request_id)
			return
		end
		local path = SPOOL .. "/response-" .. self._pending.id .. ".json"
		if minetest.get_us_time() - self._pending.started > (COUNT * 135 + 30) * 1000000 then
			os.remove(path)
			ev("fail=model-timeout agent=%d request=%d", self._id, self._pending.id)
			S.failed = "model-timeout"
			summary_and_stop()
			return
		end
		local f = io.open(path, "r")
		if not f then
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
			summary_and_stop()
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
		ev("ev=model-action agent=%d request=%d kind=%s origin=%s latency_ms=%s input_tokens=%s output_tokens=%s",
			self._id, id, action.kind, action.why == "fixture" and "fixture" or "model", tostring(audit.latency_ms or "unknown"),
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
	measured = PROFILE and minetest.get_us_time()
	local ok, reason = apply(self, action, pos)
	local point = action.point
	if action.kind == "mark" then point = {x=fp(pos.x)+self._facing.x, y=fp(pos.y), z=fp(pos.z)+self._facing.z} end
	if action.kind == "advance" then point = self.object:get_pos() end
	local detail = point and string.format("position=%s,%s,%s", tostring(point.x), tostring(point.y), tostring(point.z)) or nil
	local delivered = action.kind == "say" and ok
	local operation_id = string.format("%s:agent:%d:decision:%d", EVENT_NAMESPACE,
		self._id, self._decisions + 1)
	local committed, event = pcall(event_log.commit, event_log, operation_id, {
		time = minetest.get_gametime(), kind = action.kind, actor = tostring(self._id), ok = ok,
		reason = reason or "unspecified", detail = detail, point = point,
		participants = delivered and {tostring(action.target)} or {},
	})
	if not committed then
		ev("fail=world-event agent=%d detail=%s", self._id, tostring(event):gsub("%s+", "_"))
		S.failed = "world-event"
		summary_and_stop()
		return
	end
	if LONG_TERM then
		local recorded, detail = pcall(history.record_outcome, history, tostring(self._id),
			action.kind, ok, reason or "unspecified", minetest.get_gametime(),
			delivered and tostring(action.target) or nil, delivered and action.text or nil, detail, event.id)
		if not recorded then
			ev("fail=long-term-record agent=%d detail=%s", self._id, tostring(detail):gsub("%s+", "_"))
			S.failed = "long-term-record"
			summary_and_stop()
			return
		end
	end
	if measured then profile.action = profile.action + minetest.get_us_time() - measured end
	self._last_action = {kind = action.kind, point = action.point, ok = ok, reason = reason}
	self._last_action.attempt_id = operation_id
	self._last_action.event_id = event.id
	-- Product worlds expose the durable product commit revision. The event
	-- count remains an audit detail and must not masquerade as a cross-store
	-- revision for model decisions.
	self._last_action.world_revision = WORLD_PRODUCT and product_state:version() or event_log:count()

	local decided_at = minetest.get_us_time()
	if self._decided_at then
		local gap = (decided_at-self._decided_at)/1e6
		cadence.n, cadence.sum = cadence.n+1, cadence.sum+gap
		cadence.min, cadence.max = math.min(cadence.min,gap), math.max(cadence.max,gap)
	end
	self._decided_at = decided_at
	self._decisions = self._decisions + 1
	S.decisions = S.decisions + 1

	measured = PROFILE and minetest.get_us_time()
	local after = self.object:get_pos()
	if after then
		settle_contacts(self, {x = fp(after.x), y = fp(after.y), z = fp(after.z)})
	end
	if measured then profile.contact = profile.contact + minetest.get_us_time() - measured end
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
	-- Per-entity counters prove participation within each sampled interval.
	on_step = function(self, dtime)
		self._steps = (self._steps or 0) + 1
		S.step_ticks = S.step_ticks + 1
	end,
})

local function spawn_agents()
	local saved
	if PERSIST and not RESTORE and initial_state ~= "" then
		ev("fail=checkpoint-exists reason=restore-or-explicit-new-world-required")
		S.failed = "checkpoint-exists"
		summary_and_stop()
		return
	end
	if RESTORE then
		local decoded = minetest.parse_json(initial_state)
		local valid, restored, restored_history, restored_events = pcall(
			persistence.unpack_checkpoint, decoded, long_term_memory, world_events)
		if not valid or #restored ~= COUNT or (RESET_MINDS and restored_history:count() > 0) then
			ev("fail=restore-invalid expected=%d detail=%s", COUNT, tostring(restored):gsub("%s+", "_"))
			S.failed = "restore-invalid"
			summary_and_stop()
			return
		end
		saved, history, event_log = restored, restored_history, restored_events
		for i = 1, COUNT do
			local ok, state = pcall(persistence.validate, saved[i])
			if ok then ok = pcall(resources.validate_inventory, state.inventory) end
			if not ok or state.id ~= i - 1 or not in_bounds(state.pos) then
				ev("fail=restore-invalid agent=%d reason=validation", i - 1)
				S.failed = "restore-invalid"
				summary_and_stop()
				return
			end
		end
		S.marks = #minetest.find_nodes_in_area(
			{x = -BOUND, y = 0, z = -BOUND}, {x = BOUND, y = 4, z = BOUND}, {MARK_NODE})
	end
	local cols = math.ceil(math.sqrt(COUNT))
	local offset = -math.floor((cols - 1) * SPACING / 2)
	for i = 0, COUNT - 1 do
		local origin_actor = WORLD_PRODUCT and genesis_manifest.actors[i + 1] or nil
		local x = offset + (i % cols) * SPACING
		local z = offset + math.floor(i / cols) * SPACING
		local at = {x = ORIGIN.x + x, y = ORIGIN.y, z = ORIGIN.z + z}
		if GENESIS_PREVIEW then at = preview_actors[i + 1].position end
		if origin_actor then at = origin_actor.position end
		local obj = minetest.add_entity(at, "society:agent")
		if not obj then
			ev("fail=spawn agent=%d at=%d,%d,%d reason=add_entity-returned-nil", i, at.x, at.y, at.z)
			S.failed = S.failed or "spawn-failed"
		else
			local le = obj:get_luaentity()
			le._id = i
			le._persona = PERSONAS[(i % #PERSONAS) + 1]
			if GENESIS_PREVIEW then le._genesis = preview_actors[i + 1]; le._persona = le._genesis.name end
			if origin_actor then
				le._genesis = origin_actor
				le._persona = origin_actor.name
				le._actor_id = origin_actor.actor_id
			end
			if VISUAL then
				local colors = {"#65a8dd", "#e5a768", "#b790d3", "#77bb8c", "#e487a0"}
				obj:set_properties({visual="mesh", mesh="character.b3d", visual_size={x=1, y=1},
					textures={"player.png^[colorize:" .. colors[(i % #colors) + 1] .. ":100"},
					nametag=le._persona .. "\nWaiting", nametag_color="#ffffff"})
			end
			le._home = at
			le._facing = FACINGS[(i % #FACINGS) + 1]
			le._target = nil
			le._rng = (SEED + i * 7919) % 2147483648
			le._decisions = 0
			le._marks_placed = 0
			le._memory = {met = {}, idle_streak = 0}
			le._episodic = cognition_memory.new(32)
			le._inbox = {}
			if saved then
				local ok, detail = pcall(persistence.restore, le, saved[i + 1], {reset_minds = RESET_MINDS})
				if not ok or le._id ~= i then
					local state = saved[i + 1] or {}
					ev("fail=restore-invalid agent=%d detail=%s saved_id=%s met_type=%s episodes_type=%s", i,
						tostring(detail):gsub("%s+", "_"), tostring(state.id),
						type(state.memory and state.memory.met), type(state.episodic))
					S.failed = "restore-invalid"
					summary_and_stop()
					return
				end
				if RESET_MINDS then
					le._persona = "new-" .. PERSONAS[(i % #PERSONAS) + 1]
					le._decisions = 0
				end
				ev("ev=restore agent=%d reset=%s memories=%d", i, tostring(RESET_MINDS), le._episodic:size())
			end
			-- A resumed run gets a fresh decision quota without erasing the
			-- character's persisted lifetime counter.
			le._run_start_decisions = le._decisions
			le._resources = resources.new(minetest, obj, le._restored_inventory)
			if (MODEL or SEED_RESOURCES) and not RESTORE and not GENESIS_PREVIEW then
				local resource_pos = {x = at.x + 1, y = at.y, z = at.z}
				if in_bounds(resource_pos) and minetest.get_node(resource_pos).name == "air" then
					minetest.set_node(resource_pos, {name = "society:resource"})
				end
			end
			if OPTIMIZED then index:upsert(i, obj, obj:get_pos()) end
			agents[i] = le
			S.spawned = S.spawned + 1
		end
	end
	if WORLD_PRODUCT and not RESTORE and LONG_TERM then
		local origin_id = genesis_manifest.origin_event_id
		history:append({layer="L0", id=origin_id, owner="world", time=0,
			text="World origin: " .. genesis_manifest.public.title,
			source={kind="genesis", id=origin_id}})
		for i = 0, COUNT - 1 do
			local actor = agents[i]
			for _, seed in ipairs(actor._genesis.memory_seeds or {}) do
				history:append({layer="L1", id=seed.seed_id, owner=tostring(i), time=0,
					text="I remember: " .. seed.text,
					source={kind="event", id=origin_id}, classification="unknown"})
			end
			ev("ev=genesis-memory agent=%d actor_id=%s seeds=%d", i,
				tostring(actor._genesis.actor_id), #(actor._genesis.memory_seeds or {}))
		end
	end
	ev("spawn count=%d ok=%d spacing=%d bound=%d", COUNT, S.spawned, SPACING, BOUND)
	step_count, last_us = 0, minetest.get_us_time()
	run_started = last_us
	if MODEL or SEED_RESOURCES then
		local in_world, inventory = resource_total()
		resource_initial = in_world + inventory
	end
end

summary_and_stop = function()
	local elapsed = run_started and (minetest.get_us_time()-run_started)/1e6 or 0
	local cache = cached_nodes:stats()
	ev("performance elapsed_s=%.6f decisions_per_sec=%.3f object_queries=%d node_hits=%d node_misses=%d callback_us=%.0f max_callback_us=%.0f observe_us=%.0f action_us=%.0f contact_us=%.0f log_us=%.0f",
		elapsed, elapsed > 0 and S.decisions/elapsed or 0, object_queries, cache.hits, cache.misses,
		profile.callback, profile.max_callback, profile.observe, profile.action, profile.contact, profile.log)
	ev("cadence samples=%d mean_s=%.6f min_s=%.6f max_s=%.6f target_s=%.3f", cadence.n,
		cadence.n>0 and cadence.sum/cadence.n or 0, cadence.n>0 and cadence.min or 0, cadence.max, INTERVAL)
	ev("summary spawned=%d alive=%d decisions=%d rounds=%d marks=%d meetings=%d actions=%s",
		S.spawned, alive_agents(), S.decisions, S.driver_rounds, S.marks, S.meets, action_string())
	ev("done result=%s reason=%s", S.failed and "fail" or "ok", S.failed or "decisions-reached")
	minetest.request_shutdown()
end

fail = function(reason, fmt, ...)
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

local function apply_product_projection()
	if not WORLD_PRODUCT then return end
	local plan = world_projection.plan(genesis_manifest)
	local components = product_state:components()
	if components.map > 0 then
		for _, operation in ipairs(plan.operations) do
			if operation.kind == "node" then
				local expected = operation.value and operation.value.name or "air"
				-- Non-air origin nodes are immutable projection facts. Air
				-- clearances are the dynamic surface for resources, marks and
				-- later interactions, so they must not freeze a valid world.
				if expected ~= "air" then
					local actual = minetest.get_node_or_nil(operation.position)
					if not actual or actual.name ~= expected then
						freeze_product_state("origin projection differs from committed map")
						fail("product-reconcile", "map=%s expected=%s actual=%s", operation.key, expected,
							actual and actual.name or "unknown")
						return false
					end
				end
			end
		end
		ev("origin projection verified world_id=%s origin_event=%s operations=%d", plan.world_id,
			plan.origin_event_id, #plan.operations)
		return true
	end
	local target = components
	target.map = 1
	product_state:prepare("origin-projection:" .. genesis_manifest.origin_event_id, target)
	save_product_state()
	for _, operation in ipairs(plan.operations) do
		if operation.kind == "node" then
			local desired = operation.value
			local name = desired and desired.name or "air"
			local current = minetest.get_node(operation.position).name
			if current ~= name then
				minetest.set_node(operation.position, {name = name})
			end
			if minetest.get_node(operation.position).name ~= name then
				fail("world-projection", "node=%s expected=%s", operation.key, name)
				return false
			end
		end
	end
	local committed = product_state:commit("origin-projection:" .. genesis_manifest.origin_event_id, target)
	local encoded = minetest.write_json(committed)
	storage:set_string("product_state", encoded)
	assert(storage:get_string("product_state") == encoded, "origin projection state write/readback failed")
	ev("origin projection world_id=%s origin_event=%s operations=%d", plan.world_id,
		plan.origin_event_id, #plan.operations)
	return true
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
			if minetest.forceload_block({x = bx * 16, y = 0, z = bz * 16}, true, -1) then
				ok = ok + 1
			end
		end
	end
	ev("forceload blocks=%d/%d bound=%d", ok, tried, BOUND)
	if GENESIS_PREVIEW and ok ~= tried then fail("preview-forceload", "loaded=%d expected=%d", ok, tried); return end

	minetest.emerge_area({x = -BOUND, y = 0, z = -BOUND}, {x = BOUND, y = 16, z = BOUND},
		function(blockpos, action, calls_remaining)
			if calls_remaining == 0 then
				local first_product_projection = WORLD_PRODUCT
					and product_state:components().map == 0
				if VISUAL or first_product_projection then
					for x = -BOUND, BOUND do
						for z = -BOUND, BOUND do
							minetest.set_node({x=x, y=0, z=z}, {name="default:dirt_with_grass"})
						end
					end
				end
				if WORLD_PRODUCT and not apply_product_projection() then return end
				if WORLD_PRODUCT then spawn_view_scene() end
				if S.failed then return end
                if GENESIS_PREVIEW then
                    for _, actor in ipairs(preview_actors) do
                        local p = actor.position
                        local ground = minetest.get_node_or_nil({x=p.x, y=0, z=p.z})
                        local feet = minetest.get_node_or_nil(p)
                        local head = minetest.get_node_or_nil({x=p.x, y=2, z=p.z})
                        if not ground or ground.name ~= "default:dirt_with_grass" or not feet or feet.name ~= "air" or not head or head.name ~= "air" then
                            fail("preview-unsafe-spawn", "agent=%d", actor.ordinal); return
                        end
                    end
                    ev("preview mode=disposable persistent=false terrain=flat connections=none")
                end
				spawn_agents()
				minetest.after(1, verify_spawn)
			end
		end)
end)

local driver_acc = 0

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

local function visit(i)
	local le = agents[i]
	if le and le.object and le.object:get_pos() and (MAX_DECISIONS <= 0 or le._decisions < le._run_start_decisions + MAX_DECISIONS) then
		decide_and_act(le)
	end
end

local function advance_product_environment()
	if not WORLD_PRODUCT or not environment_process then return true end
	local now = math.floor(minetest.get_gametime() or 0)
	if now <= environment_last_time then return true end
	local ok, events = pcall(environment_process.advance, environment_process, now)
	if not ok then
		fail("environment", "advance=%s", tostring(events):gsub("%s+", "_"))
		return false
	end
	for _, item in ipairs(events) do
		local committed, event = pcall(event_log.commit, event_log,
			EVENT_NAMESPACE .. ":" .. item.operation_id, {
				time = item.time, kind = item.kind, actor = item.actor, ok = item.ok,
				reason = item.reason, detail = string.format("resource=%s before=%d after=%d",
					item.resource, item.before, item.after), participants = {},
			})
		if not committed then
			fail("world-event", "environment=%s", tostring(event):gsub("%s+", "_"))
			return false
		end
		local low, high = math.min(item.before, item.after), math.max(item.before, item.after)
		for amount = low + 1, high do
			local point = {x = -24 + amount, y = 1, z = -24}
			if item.after > item.before then
				if minetest.get_node(point).name == "air" then
					minetest.set_node(point, {name = "society:resource"})
				end
			else
				if minetest.get_node(point).name == "society:resource" then
					minetest.set_node(point, {name = "air"})
				end
			end
		end
		ev("ev=environment kind=%s resource=%s before=%d after=%d event=%s",
			item.kind, item.resource, item.before, item.after, event.id)
	end
	environment_last_time = now
	return true
end

local function round_done()
	if MAX_DECISIONS <= 0 then return false end
	for i = 0, COUNT - 1 do
		if not agents[i] or agents[i]._decisions < agents[i]._run_start_decisions + MAX_DECISIONS then return false end
	end
	return true
end

minetest.register_globalstep(function(dtime)
	step_count = step_count + 1
	update_view_scene(dtime)
	update_view_players()
	if S.finished or S.failed or S.spawned == 0 then return end
	if not advance_product_environment() then return end
	local frame_started = minetest.get_us_time()
	local completed = false
	if OPTIMIZED then
		if not frame_driver then
			frame_driver = scheduler.new({count=COUNT, interval_us=INTERVAL*1e6,
				budget_us=FRAME_BUDGET*1000, clock=minetest.get_us_time,
				visit=function(i) if not S.failed then visit(i) end end,
				on_round=function(number, wall, cpu)
					S.driver_rounds = number
					ev("round number=%d wall_ms=%.2f cpu_ms=%.2f", number, wall/1000, cpu/1000)
				end})
		end
		completed = frame_driver:step()
	else
		driver_acc = driver_acc + dtime
		local rounds = 0
		while driver_acc >= INTERVAL do
			driver_acc = driver_acc - INTERVAL
			rounds = rounds + 1
			if rounds > 5 then driver_acc = 0; break end
			S.driver_rounds = S.driver_rounds + 1
			local started = minetest.get_us_time()
			for i = 0, COUNT - 1 do
				visit(i)
				if S.failed then return end
			end
			ev("round number=%d wall_ms=%.2f", S.driver_rounds, (minetest.get_us_time()-started)/1000)
			completed = true
			if round_done() then break end
		end
	end
	local used = minetest.get_us_time()-frame_started
	profile.callback = profile.callback+used
	profile.max_callback = math.max(profile.max_callback, used)
	if S.failed then return end
	if completed and round_done() then
		S.finished = true
		emit_stats()
		summary_and_stop()
		return
	end
	if (minetest.get_us_time()-last_us)/1e6 >= STATS_EVERY then emit_stats() end
end)

-- 被外部 SIGTERM 停掉时也要留下完整账，否则「启停」只测了成功路径。
minetest.register_on_shutdown(function()
	local checkpoint_operation, checkpoint_target
	if WORLD_PRODUCT and PERSIST and not S.failed then
		local components = product_state:components()
		checkpoint_operation = "checkpoint:" .. EVENT_NAMESPACE .. ":" .. tostring(product_state:version() + 1)
		checkpoint_target = components
		checkpoint_target.actors = 1
		checkpoint_target.inventory = 1
		checkpoint_target.events = event_log:count()
		checkpoint_target.memory = history:count()
		checkpoint_target.environment = 1
		product_state:prepare(checkpoint_operation, checkpoint_target)
		save_product_state()
		ev("product-checkpoint prepare operation=%s", checkpoint_operation)
	end
	if WORLD_PRODUCT and environment_process then
		local encoded = minetest.write_json(environment_process:export())
		local written = pcall(storage.set_string, storage, "environment_state", encoded)
		if not written or storage:get_string("environment_state") ~= encoded then
			ev("fail=persist-environment reason=write-or-readback")
			return
		else
			ev("environment-checkpoint time=%d", environment_process:export().time)
			-- The environment checkpoint and product clock are one recovery
			-- boundary. Update the in-memory clock before committing the
			-- product state, otherwise the next boot sees a false divergence.
			set_product_clock(environment_process:export().time, os.time())
		end
	end
	if resource_initial then
		local in_world, inventory = resource_total()
		ev("resource-verify initial=%d world=%d inventory=%d ok=%s", resource_initial,
			in_world, inventory, tostring(resource_initial == in_world + inventory))
	end
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
		local ok, encoded = pcall(function()
			local checkpoint = (LONG_TERM or history:count() > 0 or event_log:count() > 0)
				and persistence.pack_checkpoint(saved, history, event_log, LONG_TERM) or saved
			local json = minetest.write_json(checkpoint)
			assert(type(json) == "string" and json ~= "", "checkpoint encoding failed")
			return json
		end)
		if not ok then
			ev("fail=persist reason=encode")
			return
		end
		local written = pcall(storage.set_string, storage, "agent_state", encoded)
		if not written or storage:get_string("agent_state") ~= encoded then
			ev("fail=persist reason=write-or-readback")
			return
		end
		ev("persist agents=%d", #saved)
		if LONG_TERM or history:count() > 0 or event_log:count() > 0 then
			ev("long-term-checkpoint records=%d world-events=%d scope=normal-shutdown no-map-transaction=true crash-recovery=false", history:count(), event_log:count())
		end
	end
	if WORLD_PRODUCT and checkpoint_operation then
		local committed = product_state:commit(checkpoint_operation, checkpoint_target)
		local encoded = minetest.write_json(committed)
		storage:set_string("product_state", encoded)
		assert(storage:get_string("product_state") == encoded, "product checkpoint state write/readback failed")
		storage:set_string("product_active_run", "")
		assert(storage:get_string("product_active_run") == "", "product active marker clear failed")
		product_active_run = false
		ev("product-checkpoint commit version=%d events=%d memory=%d", product_state:version(),
			event_log:count(), history:count())
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
	ev("configuration optimized=%s frame_budget_ms=%.1f memory_mode=%s profile=%s", tostring(OPTIMIZED), FRAME_BUDGET, MEMORY_MODE, tostring(PROFILE))
	ev("artifact init_sha256=%s policy_sha256=%s",
		sha256_file(mp .. "/init.lua"), sha256_file(mp .. "/policy.lua"))
end)
