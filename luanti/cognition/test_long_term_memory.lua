local directory = (arg[0] or ""):match("^(.*[/\\])") or ""
local memory = dofile(directory .. "long_term_memory.lua")
local store = memory.new()
local function event(id)
  return {layer="L0", id=id, owner="world", time=1, text="private conversation",
    source={kind="world", id="commit-1"}}
end
local function experience(id, owner, text)
  return {layer="L1", id=id, owner=owner, time=2, text=text,
    source={kind="event", id="event-1"}, classification="belief", importance=0.8}
end
local function reflection(id, owner, version, sources)
  return {layer="L2", id=id, owner=owner, time=3, text="my interpretation",
    source={kind="reflection", id="reasoner"}, topic="meeting", version=version,
    experiences=sources}
end
local function query(owner, options)
  return store:retrieve(owner, options or {query="", max_scan=100, max_entries=100, max_bytes=100000})
end
local function rejected(fn) assert(not pcall(fn)) end

local raw = event("event-1")
store:append(raw)
raw.text = "tampered"; raw.source.id = "tampered"
local alice = experience("alice-1", "alice", "heard a rumor")
store:append(alice)
alice.text = "tampered"; alice.source.id = "tampered"
store:append(experience("bob-1", "bob", "heard something else"))
store:append(reflection("reflection-1", "alice", 1, {"alice-1"}))
store:append(reflection("reflection-2", "alice", 2, {"alice-1"}))
rejected(function() store:append(event("event-1")) end)
rejected(function() local e = experience("bad", "alice", "missing"); e.source.id = "missing"; store:append(e) end)
rejected(function() store:append(reflection("bad", "alice", 3, {"bob-1"})) end)
rejected(function() store:append(reflection("bad", "alice", 3, {"reflection-1"})) end)
rejected(function() store:append(reflection("bad", "alice", 4, {"alice-1"})) end)
rejected(function() local e = event("bad"); e.extra = true; store:append(e) end)
local rows = query("alice")
assert(#rows == 3 and rows[3].text == "heard a rumor" and rows[3].source.id == "event-1")
rows[3].source.id = "altered"; rows[1].experiences[1] = "bob-1"
assert(query("alice")[3].source.id == "event-1")
assert(query("alice")[1].experiences[1] == "alice-1")
assert(#query("bob") == 1 and #query("world") == 0 and #query("stranger") == 0)
local result, meta = query("alice", {query="", max_scan=2, max_entries=1, max_bytes=100000})
assert(#result == 1 and meta.scanned == 2 and meta.omitted == 1 and meta.remaining == 1)
assert(meta.scan_limited and meta.result_limited and meta.next_cursor == 2)
local last, last_meta = query("alice", {query="", cursor=meta.next_cursor, max_scan=2, max_entries=2, max_bytes=100000})
assert(#last == 1 and last[1].id == "alice-1" and not last_meta.scan_limited)
local omitted, tiny = query("alice", {query="", max_scan=100, max_entries=100, max_bytes=2})
assert(#omitted == 0 and tiny.omitted == 3 and tiny.byte_bound == 2)
local filtered, filter_meta = query("alice", {query="rumor", max_scan=100, max_entries=100, max_bytes=100000})
assert(#filtered == 1 and filter_meta.matched == 1 and filter_meta.omitted == 0)
rejected(function() query("alice", {query="", max_scan=0, max_entries=1, max_bytes=2}) end)
rejected(function() query("alice", {query="", max_scan=1, max_entries=1, max_bytes=2, cursor=99}) end)

local snapshot = store:export()
assert(#snapshot.records == 5 and snapshot.records[1].text == "private conversation")
local restored = memory.load(snapshot)
snapshot.records[1].text = "tampered"
snapshot.records[2].source.id = "tampered"
assert(restored:export().records[1].text == "private conversation")
assert(restored:retrieve("alice", {query="", max_scan=100, max_entries=100, max_bytes=100000})[3].source.id == "event-1")
local exported = restored:export(); exported.records[1].text = "tampered again"
assert(restored:export().records[1].text == "private conversation")
local bad = store:export(); bad.records[4].experiences[1] = "bob-1"
rejected(function() memory.load(bad) end)
bad = store:export(); bad.records[5].version = 5
rejected(function() memory.load(bad) end)
bad = store:export(); bad.records[3] = nil
rejected(function() memory.load(bad) end)
assert(#store:export().records == 5)
local many = memory.new()
many:append(event("event-1"))
for i = 1, 100 do many:append(experience("item-" .. i, "alice", "entry " .. i)) end
local first, page = many:retrieve("alice", {query="", max_scan=2, max_entries=2, max_bytes=100000})
assert(first[1].id == "item-100" and page.remaining == 98)
many:append(experience("item-101", "alice", "later"))
local next_page = many:retrieve("alice", {query="", cursor=page.next_cursor, max_scan=2, max_entries=2, max_bytes=100000})
assert(next_page[1].id == "item-98" and #many:export().records == 102)
local outcomes = memory.new()
outcomes:record_outcome("0", "say", true, "delivered", 1, "1", "secret")
outcomes:record_outcome("0", "build", false, "insufficient inventory", 2)
local function own(id)
  return outcomes:retrieve(id, {query="", max_scan=100, max_entries=100, max_bytes=100000})
end
assert(#own("0") == 2 and #own("1") == 1 and #own("2") == 0)
assert(own("0")[1].text:find("failed", 1, true))
assert(own("1")[1].text:find("secret", 1, true))
rejected(function() outcomes:record_outcome("0", "say", false, "gone", 3, "1", "x") end)
assert(outcomes:count() == 5)
print("long-term memory tests passed")
