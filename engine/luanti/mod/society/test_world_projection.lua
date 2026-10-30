-- Offline pure Lua tests. From repository root:
-- lua engine/luanti/mod/society/test_world_projection.lua
local projection = dofile('engine/luanti/mod/society/world_projection.lua')
local count = 0
local function copy(v)
  if type(v) ~= 'table' then return v end
  local result = {}; for k,item in pairs(v) do result[k] = copy(item) end
  return result
end
local function equal(a,b)
  if type(a) ~= type(b) then return false end
  if type(a) ~= 'table' then return a == b end
  for k,v in pairs(a) do if not equal(v,b[k]) then return false end end
  for k in pairs(b) do if a[k] == nil then return false end end
  return true
end
local function fixture()
  return {format='wispiva-world-manifest', version=1, world_id='12345678-1234-4234-8234-123456789abc',
    origin_event_id='origin-1', public={
      places={{id='home',space='indoor',anchor={x=0,y=1,z=0}},
              {id='yard',space='outdoor',anchor={x=10,y=1,z=4}}},
      semantic_connections={{from='home',to='yard'}},
      actors={{actor_id='alice',ordinal=0,place_id='home',position={x=0,y=1,z=1},
        goal='PRIVATE',memory_seeds={'SECRET'}}},
      objects={{id='supplies',place_id='home',position={x=1,y=1,z=1},node='default:chest'}}}}
end
local function fake(manifest)
  local state, writes = {}, {}
  local adapter = {
    binding=function() return {world_id=manifest.world_id,origin_event_id=manifest.origin_event_id} end,
    read=function(op)
      if state[op.key] == nil then return false end
      return copy(state[op.key])
    end,
    write=function(op)
      writes[#writes+1] = copy(op); state[op.key] = copy(op.value)
    end}
  return adapter,state,writes
end
local function fails(fn, message)
  local ok,err = pcall(fn)
  assert(not ok, 'expected rejection: ' .. message)
  assert(tostring(err):find(message,1,true), tostring(err))
end
local function test(name, fn)
  fn(); count=count+1; print('ok ' .. count .. ' - ' .. name)
end
local function find(plan,key)
  for _,op in ipairs(plan.operations) do if op.key == key then return op end end
  error('missing operation: ' .. key)
end

test('room, outdoor ground, roof, doorway and L-shaped connection', function()
  local plan = projection.plan(fixture())
  assert(find(plan,'node:0,0,1').value.name == 'default:wood')
  assert(find(plan,'node:0,4,0').value.name == 'default:wood')
  assert(find(plan,'node:-3,1,0').value.name == 'default:wood')
  assert(find(plan,'node:3,1,0').value == false) -- Door in east wall.
  assert(find(plan,'node:7,0,0').value.name == 'default:stone')
  assert(find(plan,'node:10,0,2').value.name == 'default:stone')
  assert(find(plan,'node:12,0,6').value.name == 'default:dirt_with_grass')
  assert(find(plan,'node:10,2,2').value == false)
end)

test('actor identity and interactive object binding preserved without secrets', function()
  local plan = projection.plan(fixture())
  local actor = find(plan,'actor:alice').value
  assert(actor.actor_id == 'alice' and actor.ordinal == 0 and actor.place_id == 'home')
  assert(actor.position.z == 1 and actor.goal == nil and actor.memory_seeds == nil)
  local object = find(plan,'node:1,1,1').value
  assert(object.name == 'default:chest' and object.object_id == 'supplies' and object.place_id == 'home')
end)

test('deterministic plan independent of input order and detached from input', function()
  local doc = fixture(); local original = copy(doc); local first = projection.plan(doc)
  doc.public.places[1],doc.public.places[2] = doc.public.places[2],doc.public.places[1]
  doc.public.semantic_connections[1] = {from='yard',to='home'}
  assert(equal(first,projection.plan(doc)))
  first.operations[1].position.x = 999
  assert(equal(original.public.places[1].anchor,{x=0,y=1,z=0}))
  assert(doc.public.places[2].anchor.x == 0)
end)

test('repeat application performs zero additional writes', function()
  local doc = fixture(); local adapter,_,writes = fake(doc)
  local result = projection.apply(doc,adapter)
  assert(result.writes > 0 and result.writes == #writes)
  local n = #writes
  assert(projection.apply(doc,adapter).writes == 0 and #writes == n)
end)

test('late unknown state fails entire preflight before writing', function()
  local doc = fixture(); local adapter,_,writes = fake(doc)
  local read = adapter.read
  adapter.read = function(op) if op.kind == 'actor' then return nil end; return read(op) end
  fails(function() projection.apply(doc,adapter) end,'unknown state')
  assert(#writes == 0)
end)

test('existing terrain and occupied clearance reject without writes', function()
  for _,key in ipairs({'node:0,0,1','node:0,2,1'}) do
    local doc = fixture(); local adapter,state,writes = fake(doc)
    state[key] = {name='default:lava_source',param2=0}
    fails(function() projection.apply(doc,adapter) end,'conflicting state')
    assert(#writes == 0)
  end
end)

test('an unbound chest is not proof of the origin object', function()
  local doc = fixture(); local adapter,state,writes = fake(doc)
  state['node:1,1,1'] = {name='default:chest',param2=0}
  fails(function() projection.apply(doc,adapter) end,'conflicting state')
  assert(#writes == 0)
end)

test('adapter must match world and origin before any writes', function()
  for _,field in ipairs({'world_id','origin_event_id'}) do
    local doc = fixture(); local adapter,_,writes = fake(doc)
    adapter.binding = function()
      local b={world_id=doc.world_id,origin_event_id=doc.origin_event_id}; b[field]='other'; return b
    end
    fails(function() projection.apply(doc,adapter) end,'binding mismatch')
    assert(#writes == 0)
  end
end)

test('partial write failure is replayed without duplicate actors', function()
  local doc = fixture(); local adapter,state,writes = fake(doc)
  local write = adapter.write
  adapter.write = function(op)
    write(op)
    if op.kind == 'actor' then error('lost write acknowledgement') end
  end
  fails(function() projection.apply(doc,adapter) end,'lost write acknowledgement')
  assert(state['actor:alice'].actor_id == 'alice')
  local n = #writes; adapter.write=write
  assert(projection.apply(doc,adapter).writes == 0 and #writes == n)
end)

test('failed write readback stops immediately and can recover', function()
  local doc = fixture(); local adapter,_,writes = fake(doc)
  local write = adapter.write
  adapter.write = function() end
  fails(function() projection.apply(doc,adapter) end,'write verification failed')
  assert(#writes == 0)
  adapter.write=write
  assert(projection.apply(doc,adapter).writes > 0)
end)

test('failure after a short prefix retries only remaining placements', function()
  local doc=fixture(); local adapter,_,writes=fake(doc); local write=adapter.write
  adapter.write=function(op)
    write(op)
    if #writes == 5 then error('interrupted prefix') end
  end
  fails(function() projection.apply(doc,adapter) end,'interrupted prefix')
  assert(#writes == 5); adapter.write=write
  local result=projection.apply(doc,adapter)
  assert(result.writes > 0)
  local keys={}
  for _,op in ipairs(writes) do assert(not keys[op.key]); keys[op.key]=true end
  assert(projection.apply(doc,adapter).writes == 0)
end)

test('adapter cannot mutate the internal plan via passed operations', function()
  local doc=fixture(); local before=copy(doc)
  local adapter,_,writes=fake(doc); local read,write=adapter.read,adapter.write
  adapter.read=function(op)
    local value=read(op); op.key='changed'; op.value={name='bad:node'}; return value
  end
  adapter.write=function(op)
    write(op); op.value.name='bad:node'; op.key='changed'
  end
  assert(projection.apply(doc,adapter).writes > 0)
  assert(equal(before,doc))
  for _,op in ipairs(writes) do assert(op.key ~= 'changed') end
  assert(projection.apply(doc,adapter).writes == 0)
end)

test('final pass detects a write that damages an earlier placement', function()
  local doc=fixture(); local adapter,state=fake(doc); local write=adapter.write
  local first
  adapter.write=function(op)
    write(op)
    if not first then first=op.key end
    if op.kind == 'actor' then state[first]=false end
  end
  fails(function() projection.apply(doc,adapter) end,'final verification failed')
end)

test('state changed after preflight is rejected', function()
  local doc = fixture(); local adapter,_,writes = fake(doc)
  local read=adapter.read; local reads=0; local total=#projection.plan(doc).operations
  adapter.read=function(op)
    reads=reads+1
    if reads > total then return {name='ignore'} end
    return read(op)
  end
  fails(function() projection.apply(doc,adapter) end,'conflicting state')
  assert(#writes == 0)
end)

test('adapter exceptions propagate and retry can proceed', function()
  local doc = fixture(); local adapter,_,writes = fake(doc); local read=adapter.read
  adapter.read=function() error('read failed') end
  fails(function() projection.apply(doc,adapter) end,'read failed')
  assert(#writes == 0); adapter.read=read
  assert(projection.apply(doc,adapter).writes > 0)
end)

test('invalid versions, identity and non-finite/fractional/large coordinates', function()
  local mutations = {
    function(d) d.version=2 end,
    function(d) d.format='genesis-disposable-preview' end,
    function(d) d.world_id='not-a-world-id' end,
    function(d) d.origin_event_id='' end,
    function(d) d.public.places[1].anchor.x=0/0 end,
    function(d) d.public.places[1].anchor.x=math.huge end,
    function(d) d.public.places[1].anchor.x=0.5 end,
    function(d) d.public.places[1].anchor.x=1000 end,
    function(d) d.public.places[1].anchor.y=2 end,
    function(d) d.public.places[1].space='underground' end,
  }
  for _,mutate in ipairs(mutations) do
    local doc=fixture(); mutate(doc)
    local adapter,_,writes=fake(doc)
    fails(function() projection.apply(doc,adapter) end,'world projection:')
    assert(#writes == 0)
  end
end)

test('invalid references, overlap and duplicate identities fail closed', function()
  local mutations = {
    function(d) d.public.actors[1].place_id='missing' end,
    function(d) d.public.objects[1].place_id='missing' end,
    function(d) d.public.semantic_connections[1].to='missing' end,
    function(d) d.public.places[2].anchor.x=0; d.public.places[2].anchor.z=0 end,
    function(d) d.public.places[2].id='home' end,
    function(d) d.public.actors[2]=copy(d.public.actors[1]) end,
    function(d) d.public.objects[2]=copy(d.public.objects[1]) end,
    function(d) d.public.semantic_connections[2]={from='yard',to='home'} end,
    function(d) d.public.actors[1].ordinal=1 end,
    function(d) d.public.objects[1].node='unknown:unsafe' end,
    function(d) d.public.objects[1].position.x=0; d.public.objects[1].position.z=1 end,
    function(d) d.public.objects[1].position.z=0 end,
    function(d) d.public.actors[1].position.x=20 end,
    function(d) d.public.objects[1].position.z=3 end,
    function(d) d.public.places[4]=copy(d.public.places[1]) end,
    function(d) d.public.objects.extra={} end,
  }
  for _,mutate in ipairs(mutations) do
    local doc=fixture(); mutate(doc)
    fails(function() projection.plan(doc) end,'world projection:')
  end
end)

test('connection routes around unrelated rooms', function()
  local doc=fixture()
  doc.public.places[2].anchor={x=16,y=1,z=0}
  doc.public.places[3]={id='middle',space='indoor',anchor={x=8,y=1,z=0}}
  local plan=projection.plan(doc)
  assert(find(plan,'node:8,0,0').value.name == 'default:wood')
  local stones=0
  for _,op in ipairs(plan.operations) do
    if op.kind == 'node' and op.value and op.value.name == 'default:stone' then stones=stones+1 end
  end
  assert(stones > 0)
end)

test('empty actors/objects/connections allowed and one-place plan applies', function()
  local doc=fixture()
  doc.public.places[2]=nil
  doc.public.actors={}; doc.public.objects={}; doc.public.semantic_connections={}
  local adapter=fake(doc)
  assert(projection.apply(doc,adapter).writes > 0)
  assert(projection.apply(doc,adapter).writes == 0)
end)

test('current persistent manifest without object extension is supported', function()
  local doc=fixture(); doc.public.objects=nil
  doc.actors={{actor_id='alice',runtime_id=0,goal='PRIVATE',memory_seeds={'SECRET'}}}
  doc.origin_event={data={private='PRIVATE'}}
  local adapter=fake(doc)
  assert(projection.apply(doc,adapter).writes > 0)
  assert(projection.apply(doc,adapter).writes == 0)
  local actor=find(projection.plan(doc),'actor:alice').value
  assert(actor.goal == nil and actor.memory_seeds == nil)
end)

print('world_projection: ' .. count .. ' tests passed')
