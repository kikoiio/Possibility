-- Also the evaluation bridge: no second retrieval implementation in Python.
local directory = (arg[0] or ""):match("^(.*[/\\])") or ""
local memory = dofile(directory .. "memory.lua")

if arg[1] == "--select" then
  local function unhex(text)
    assert(#text % 2 == 0 and not text:find("[^0-9a-f]"), "invalid hex")
    return (text:gsub("..", function(pair) return string.char(tonumber(pair, 16)) end))
  end
  local capacity, strategy, limit, budget = tonumber(arg[2]), arg[3], tonumber(arg[4]), tonumber(arg[5])
  assert(capacity and capacity <= 128 and limit and limit <= 128 and budget and budget <= 16384)
  local store = memory.new(capacity)
  local query = unhex(assert(io.read("*l")))
  local lines = 0
  for line in io.lines() do
    lines = lines + 1
    assert(lines <= 256 and #line <= 32768, "bridge input too large")
    local time, kind, id_type, id, text = line:match("^([^\t]+)\t([^\t]*)\t([ns])\t([^\t]*)\t([^\t]*)$")
    assert(time, "invalid entry")
    store:add({time = tonumber(time), text = unhex(text),
      source = {kind = unhex(kind), id = id_type == "n" and tonumber(id) or unhex(id)}})
  end
  local selected, info = store:select(query, {strategy = strategy, max_entries = limit, max_chars = budget})
  io.write('{"entries":', memory.serialize(selected), ',"serialized_chars":', info.chars,
    ',"stored_entries":', store:size(), '}\n')
  return
end

local function entry(time, text, id)
  return {time = time, text = text, source = {kind = "agent", id = id or 7}}
end
local function select(store, query, strategy, count, chars)
  return store:select(query, {strategy = strategy, max_entries = count or 1, max_chars = chars or 1024})
end

local store = memory.new(8)
store:add(entry(1, "cedar vault code is OLD"))
store:add(entry(3, "cedar vault code is NEW"))
-- A delayed old event must not override the newer matching fact.
store:add(entry(2, "cedar vault code is DELAYED"))
store:add(entry(4, "the orchard is sunny", 20))
assert(select(store, "CEDAR vault code", "retrieval")[1].time == 3)
assert(select(store, "CEDAR vault code", "fifo")[1].time == 4)
assert(store:select("cedar", {mode = "retrieval", max_entries = 1})[1].time == 3)
assert(not pcall(store.select, store, "cedar", {mode = "fifo", strategy = "retrieval"}))
assert(select(store, "unknown", "retrieval")[1].time == 4)
assert(select(store, "", "retrieval")[1].time == 4)
local chosen = select(store, "cedar", "retrieval")
chosen[1].text = "mutated"; chosen[1].source.id = 999
assert(select(store, "cedar", "retrieval")[1].source.id == 7)
assert(store:list()[2].text == "cedar vault code is NEW")
local chronological = select(store, "cedar", "retrieval", 2)
assert(chronological[1].time == 3 and chronological[2].time == 2)
local fifo = select(store, "cedar", "fifo", 2)
assert(fifo[1].time == 2 and fifo[2].time == 4)

local entities = memory.new(4)
entities:add(entry(1, "observed a landmark", 2))
entities:add(entry(2, "observed a landmark", 20))
assert(select(entities, "agent 2", "retrieval")[1].source.id == 2)
entities:add(entry(3, "agent 2 reached landmark", 3))
assert(select(entities, "agent 2 landmark", "retrieval")[1].time == 3)
entities:add(entry(3, "agent 2 reached landmark", 4))
assert(select(entities, "agent 2 landmark", "retrieval")[1].source.id == 4)

local budgets = memory.new(4)
budgets:add(entry(1, 'quoted "text"\n\\\t\0', "provenance-longer-than-the-text"))
budgets:add(entry(2, "small", 2))
for _, strategy in ipairs({"fifo", "retrieval"}) do
  local all, info = select(budgets, "quoted", strategy, 4)
  assert(info.serialized == memory.serialize(all) and info.chars == #info.serialized)
  assert(info.serialized:find('\\u000a', 1, true) and info.serialized:find('\\u0000', 1, true))
  local exact = #memory.serialize({budgets:list()[1]})
  local one, meta = select(budgets, "quoted", strategy, 1, exact)
  assert(#one == 1 and meta.chars <= exact)
  local smaller, small_meta = select(budgets, "quoted", strategy, 1, exact - 1)
  assert(#smaller == 1 and smaller[1].text == "small" and small_meta.chars <= exact - 1)
  assert(#select(budgets, "", strategy, 4, 2) == 0)
  assert(#budgets:select("", {strategy = strategy, max_entries = 0}) == 0)
end
local unicode = memory.new(1)
unicode:add(entry(1, "你好", "é"))
local utf, utf_info = select(unicode, "你好", "retrieval")
assert(utf[1].text == "你好" and utf_info.chars == #memory.serialize(utf))
assert(#select(unicode, "", "fifo", 1, utf_info.chars - 1) == 0)

local chinese = memory.new(2)
chinese:add(entry(1, "甲今天在北边井旁取了水", "north-well"))
chinese:add(entry(2, "甲今天在南边井旁修好了木桶", "south-well"))
assert(select(chinese, "北边井", "retrieval")[1].source.id == "north-well",
  "Chinese query fragments should retrieve the matching event despite surrounding prose")
chinese:add(entry(3, "safe malformed UTF-8: " .. string.char(0xE0, 0x80, 0x80, 0xED, 0xA0, 0x80,
  0xF0, 0x80, 0x80, 0x80, 0xF4, 0x90, 0x80, 0x80, 0xE4, 0xB8), "malformed"))
assert(select(chinese, "safe", "retrieval")[1].source.id == "malformed",
  "malformed UTF-8 must be traversed without stalling or raising")

local bounded = memory.new(2)
local original = entry(1, "needle")
bounded:add(original); original.text = "overwritten"; original.source.id = 88
assert(select(bounded, "needle", "retrieval")[1].source.id == 7)
bounded:add(entry(2, "middle")); bounded:add(entry(3, "end"))
assert(bounded:size() == 2 and bounded:list()[1].text == "middle")
assert(select(bounded, "needle", "retrieval")[1].text == "end")
local restored = memory.new(2)
for _, fact in ipairs(bounded:list()) do restored:add(fact) end
assert(memory.serialize(restored:list()) == memory.serialize(bounded:list()))
bounded:clear(); assert(#select(bounded, "needle", "retrieval") == 0 and restored:size() == 2)
local zero = memory.new(0)
assert(not zero:add(entry(1, "unused")) and #zero:select("") == 0)
for _, options in ipairs({{strategy = "semantic"}, {max_entries = -1}, {max_entries = 1.5},
    {max_chars = 1}, {max_chars = 0/0}, {max_chars = math.huge}, false, "x"}) do
  -- false is an invalid option, not the same as an omitted option.
  assert(not pcall(budgets.select, budgets, "query", options))
end
assert(not pcall(budgets.select, budgets, {}))
print("retrieval tests passed")
