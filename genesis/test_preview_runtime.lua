-- Offline unit harness: load the real runtime and invoke its action executor.
local original_dofile, original_open = dofile, io.open
local doc = {format='genesis-disposable-preview', version=1, draft_id=string.rep('a',32), revision=1, actors={}}
for i = 1, 3 do
  doc.actors[i] = {id='actor'..i, ordinal=i-1, name='Person'..i,
    position={x=(i-1)*2,y=1,z=0}, role='Role'..i, goal='Goal'..i, memory_seeds={'Secret'..i}}
end
function dofile(path)
  local name = path:match('([^/]+)$')
  if name == 'genesis_preview.lua' then return original_dofile('genesis/preview.lua') end
  if name == 'policy.lua' then return original_dofile('engine/luanti/mod/society/policy.lua') end
  if name == 'world_projection.lua' then return original_dofile('engine/luanti/mod/society/world_projection.lua') end
  return original_dofile('cognition/' .. name)
end
function io.open(path, mode)
  if path == 'fixture-manifest' then return {read=function() return '{}' end, close=function() end} end
  return original_open(path, mode)
end
local settings = {society_genesis_preview='true', society_genesis_private_manifest='fixture-manifest',
  society_count='3', society_model='true', society_cognition='true', society_visual='true'}
local step, logs, writes
logs, writes = {}, 0
minetest = {
  settings={get=function(_, k) return settings[k] end}, get_modpath=function() return '/fake' end,
  get_mod_storage=function() return {get_string=function() return '' end} end,
  get_us_time=function() return 1 end, get_gametime=function() return 10 end,
  parse_json=function() return doc end, log=function(_, msg) logs[#logs+1] = msg end,
  sha256=function() return 'hash' end,
  register_node=function() end, register_entity=function() end,
  register_globalstep=function(fn) step=fn end, register_on_shutdown=function() end,
  after=function() end, get_objects_inside_radius=function() return {} end,
  find_nodes_in_area=function() return {} end,
  registered_nodes={air={walkable=false}, ['default:stone']={walkable=true},
    ['society:resource']={walkable=true}},
  get_node_or_nil=function(pos)
    return {name = pos.y == 0 and 'default:stone' or 'air'}
  end,
  get_node=function() return {name='air'} end, set_node=function() writes=writes+1 end,
}
original_dofile('engine/luanti/mod/society/init.lua')
dofile, io.open = original_dofile, original_open
local function findfn(fn, wanted, seen)
  if seen[fn] then return nil end
  seen[fn] = true
  local i=1
  while true do
    local name, value = debug.getupvalue(fn, i)
    if not name then break end
    if name == wanted then return value end
    if name ~= '_ENV' and type(value) == 'function' then
      local found = findfn(value, wanted, seen)
      if found then return found end
    end
    i=i+1
  end
end
local apply = assert(findfn(step, 'apply', {}), 'missing action executor')
local agents = assert(findfn(apply, 'agents', {}), 'missing agent registry')
local function actor(id, x)
  local pos={x=x,y=1,z=0}
  local object={get_pos=function() return pos end, set_pos=function(_, next) pos=next end,
    set_properties=function() end}
  local episodes={items={},add=function(self, e) self.items[#self.items+1]=e end}
  return {_id=id, _persona='Person'..id, object=object, _inbox={}, _episodic=episodes,
    _memory={met={},idle_streak=0}, _facing={x=1,z=0}}
end
local sender, recipient, third = actor(0,0),actor(1,2),actor(2,4)
sender.name, recipient.name, third.name = 'society:agent', 'society:agent', 'society:agent'
sender._genesis = {goal='PRIVATE_GOAL', memory_seeds={'PRIVATE_MEMORY'}}
for _, entity in ipairs({sender, recipient, third}) do
  entity.object.get_luaentity = function() return entity end
end
local observe = original_dofile('cognition/observation.lua')
local visible = observe.observe({get_objects_inside_radius=function() return {sender.object, recipient.object, third.object} end,
  find_nodes_in_area=function() return {} end, get_node_or_nil=function() return {name='air'} end},
  third.object, {radius=12, node_names={}})
for _, seen in ipairs(visible.agents) do
  assert(seen.id ~= nil and seen.pos ~= nil and seen.goal == nil and seen.memory_seeds == nil and seen._genesis == nil)
end
agents[0], agents[1], agents[2] = sender, recipient, third
local ok, why = apply(sender, {kind='say', target=1, text='Secret1', why='fixture'}, sender.object:get_pos())
assert(ok and why=='delivered' and recipient._inbox[1].text=='Secret1' and #third._inbox==0)
assert(#recipient._episodic.items==1 and #third._episodic.items==0)
ok, why = apply(sender, {kind='wander', point={x=6,y=1,z=0}, why='fixture'}, sender.object:get_pos())
assert(ok and why=='destination-set' and sender._target.x==6)
ok, why = apply(sender, {kind='advance', why='fixture'}, sender.object:get_pos())
assert(ok and why=='moved' and sender.object:get_pos().x==2)
ok, why = apply(sender, {kind='mark', why='fixture'}, sender.object:get_pos())
assert(not ok and why=='preview-world-write-unsupported' and writes==0)
for _, kind in ipairs({'gather','build'}) do
  ok, why = apply(sender, {kind=kind, point={x=1,y=1,z=0}, why='fixture'}, sender.object:get_pos())
  assert(not ok and why=='preview-world-write-unsupported' and writes==0)
end
assert(table.concat(logs, '\n'):find('ev=preview%-action%-rejected'))
