-- Lightweight main-loop simulation; it does not start Luanti or access a world.
local real_dofile, real_open, real_remove = dofile, io.open, os.remove
local objects, callbacks, encoded, writes, contexts, logs = {}, {}, {}, {}, {}, {}
local saved_text, clock, serial, entity_def = "", 0, 0
local config = {society_count="3", society_optimized="false", society_spacing="1",
  society_decide_interval="1", society_max_decisions="0", society_model="true",
  society_persist="true", society_long_term_memory="true", society_visual="true",
  society_spool="mock"}
local function make_engine(fail_spawn)
  objects, callbacks, contexts, logs = {}, {}, {}, {}
  minetest = {
    settings={get=function(_, key) return config[key] end},
    get_modpath=function() return "society" end,
    get_mod_storage=function() return {get_string=function() return saved_text end,
      set_string=function(_, _, value) saved_text=value; writes[#writes+1]=value end} end,
    get_us_time=function() clock=clock+100; return clock end,
    get_gametime=function() return clock/1000000 end,
    log=function(_, s) logs[#logs+1]=s end,
    register_node=function() end, register_entity=function(_, def) entity_def=def end,
    register_globalstep=function(fn) callbacks.step=fn end,
    register_on_shutdown=function(fn) callbacks.shutdown=fn end,
    after=function(delay, fn) if delay == 1 then callbacks.spawn=callbacks.spawn or fn end end,
    forceload_block=function() return true end,
    emerge_area=function(_, _, cb) cb(nil,nil,0) end,
    find_nodes_in_area=function() return {} end,
    get_node_or_nil=function() return {name="air"} end,
    get_node=function() return {name="air"} end, set_node=function() end,
    get_objects_inside_radius=function() return objects end,
    add_entity=function(pos)
      if fail_spawn and #objects == 1 then return nil end
      local entity = {name="society:agent"}
      local object = {pos=pos, properties={}}
      function object:get_pos() return self.pos end
      function object:set_pos(p) self.pos=p end
      function object:get_luaentity() return entity end
      function object:set_properties(p) for k,v in pairs(p) do self.properties[k]=v end end
      entity.object=object
      entity_def.on_activate(entity)
      objects[#objects+1]=object
      return object
    end,
    sha256=function() return "hash" end,
    write_json=function(value)
      serial=serial+1
      local key="encoded" .. serial
      encoded[key]=value
      return key
    end,
    parse_json=function(value) return encoded[value] end,
    safe_file_write=function(path, value)
      local id=tonumber(path:match("request%-(%d+)"))
      local key=value:match('"context":(encoded%d+)')
      contexts[id]=encoded[key]
      return true
    end,
    request_shutdown=function() end,
  }
  dofile=function(path)
    if path:match("^society/") then
      local name=path:match("([^/]+)$")
      if name == "policy.lua" then return real_dofile("../agent/mod/society/policy.lua") end
      return real_dofile(name)
    end
    return real_dofile(path)
  end
  io.open=function(path, mode)
    local id=tonumber(path:match("response%-(%d+)"))
    if id and contexts[id] then
      local actor=contexts[id].self_id
      local action=actor == 0 and id == 1 and {kind="say", target=1, text="private secret"}
        or actor == 0 and id == 4 and {kind="build", point=contexts[id].observation.pos}
        or {kind="inspect"}
      serial=serial+1
      local key="encoded" .. serial
      encoded[key]={id=id, ok=true, action=action}
      return {read=function() return key end, close=function() end}
    end
    return real_open(path, mode)
  end
  os.remove=function() return true end
  real_dofile("../agent/mod/society/init.lua")
  callbacks.spawn()
end
local function step() callbacks.step(1) end
make_engine(false)
step() -- requests
step() -- deliveries and completed actions
assert(objects[1].properties.nametag == "atlas\nprivate secret")
step() -- next requests
assert(contexts[4].self_id == 0 and contexts[5].self_id == 1 and contexts[6].self_id == 2)
local function has_secret(context)
  for _, item in ipairs(context.memory) do if item.text:find("private secret", 1, true) then return true end end
  return false
end
assert(has_secret(contexts[4]) and has_secret(contexts[5]) and not has_secret(contexts[6]))
assert(contexts[6].movement_target == nil and #contexts[6].incoming_messages == 0)
step() -- build fails because the actor has no inventory
step()
assert(contexts[7].last_action.ok == false and contexts[7].last_action.reason == "insufficient inventory")
local failed_record = false
for _, item in ipairs(contexts[7].memory) do
  if item.text:find("build failed: insufficient inventory", 1, true) then failed_record = true end
end
assert(failed_record)
callbacks.shutdown()
local checkpoint = saved_text
assert(encoded[checkpoint].format == "society-checkpoint")
local record_count = #encoded[checkpoint].long_term.records
assert(record_count >= 13)
config.society_restore="true"
make_engine(true) -- a partial spawn failure must not erase or replace the checkpoint
callbacks.shutdown()
assert(saved_text == checkpoint)
make_engine(false)
assert(saved_text == checkpoint)
step()
assert(has_secret(contexts[1]) and has_secret(contexts[2]) and not has_secret(contexts[3]))
local json_write = minetest.write_json
minetest.write_json = function() error("encoding failure") end
callbacks.shutdown()
assert(saved_text == checkpoint)
minetest.write_json = json_write
callbacks.shutdown()
assert(saved_text ~= checkpoint and #encoded[saved_text].long_term.records == record_count)
local latest=encoded[saved_text]
local retained=saved_text
config.society_restore=nil
make_engine(false)
callbacks.shutdown()
assert(saved_text == retained and #objects == 0) -- no implicit overwrite without restore
config.society_restore="true"
config.society_reset_minds="true"
make_engine(false)
callbacks.shutdown()
assert(saved_text == retained and #objects == 0) -- cannot erase prior private history
config.society_reset_minds=nil
config.society_long_term_memory="false"
make_engine(false)
callbacks.shutdown()
assert(#encoded[saved_text].long_term.records == record_count) -- disabling capture preserves history
config.society_long_term_memory="true"
local legacy_key="legacy"
encoded[legacy_key]=latest.agents
saved_text=legacy_key
make_engine(false)
assert(saved_text == legacy_key)
callbacks.shutdown()
assert(encoded[saved_text].format == "society-checkpoint" and #encoded[saved_text].long_term.records == 0)
dofile, io.open, os.remove = real_dofile, real_open, real_remove
print("long-term main-loop integration tests passed")
