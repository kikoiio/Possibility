local directory = arg[1] or "."
local envelope = dofile(directory .. "/model_envelope.lua")
local e = envelope.build({
  world_id="world-1", origin_event_id="genesis:created", actor_id="alice", runtime_id=0,
  decision_id="world-1:alice:1", world_revision=3, observed_at=4,
  actor={name="Alice", role="scout", goal="Find water",
    role_source={kind="genesis.actor", id="genesis:created:alice"},
    goal_source={kind="genesis.goal", id="genesis:created:alice"}},
  permissions={read_scopes={"world.public", "self.private"}, allowed_actions={"inspect"}},
  facts={{id="world-event:1", text="A spring is here", source={kind="world_event", id="world-event:1"}, scope="public", audience={"alice"}}},
  experiences={{id="memory:1", text="I saw the spring", source={kind="observation", id="observation:1"}}},
  rumors={{id="message:1", text="The cave is unsafe", source={kind="message", id="message:1"}}},
  unknowns={{id="genesis:seed:alice:0", text="You once lived east", source={kind="genesis_seed", id="genesis:created"}}},
  observation={pos={x=0,y=1,z=0}}, inventory={}, affordances={}, feedback={available=false}})
assert(e.schema == "wispiva.model-input" and e.knowledge.facts[1].epistemic == "fact")
assert(e.knowledge.experiences[1].epistemic == "experience" and e.knowledge.rumors[1].epistemic == "rumor")
assert(e.knowledge.unknowns[1].epistemic == "unknown")
assert(envelope.validate(e))
local ok = pcall(function() envelope.build({world_id="world-1", origin_event_id="genesis:created", actor_id="alice", decision_id="1", actor={name="Alice",role="r",goal="g",role_source={kind="x",id="y"},goal_source={kind="x",id="z"}}, unknowns={{id="s",text="private",source={kind="x",id="y"},audience={"bob"}}}}) end)
assert(not ok)
print("model envelope tests passed")
