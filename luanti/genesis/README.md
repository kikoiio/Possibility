# World genesis v1

This module generates and persists drafts and can explicitly confirm a particular revision into a new `WorldStore` checkpoint. A valid draft is a bounded, referentially consistent proposal, not an executable Luanti world and not evidence that rules or spatial geometry are implemented. It does not connect to a Luanti map or agent runtime. It never falls back to a canned story after a model failure. `example.json` is only a test and documentation fixture.

## Contract

[schema.json](schema.json) is the JSON Schema 2020-12 structural contract. All properties are required; unknown properties are rejected. Arrays may be empty where the schema permits. `places` and `actors` have separate ID namespaces; `rules` have their own. Each actor starts at `placeId`; each memory belongs only to its `actorId`. Layout has exactly one entry per place, distinct integer grid coordinates, and undirected connections. Coordinates express relative semantic layout, not Luanti node positions; neither connectivity nor geometry is guaranteed. Rules are descriptive proposals, not code or enforced mechanics.

In addition to JSON Schema, `validate` enforces unique IDs within each collection, valid actor/place/memory references, exact place coverage in layout, distinct grid cells, and valid, non-self, non-duplicate undirected connections. Integers must be actual JSON integer values (not booleans or decimal-form numbers). Text must be nonblank and contain no control characters U+0000–U+001F. JSON input rejects duplicate keys, non-finite values and outputs over 8192 UTF-8 bytes. The schema alone cannot express all cross-reference checks; use `validate` as the authoritative acceptance check. Diagnostics contain only paths and codes, not model output.

`public_view(draft)` removes the entire `memories` collection and each actor's goal; `actor_memories(draft, actor_id)` returns only that actor's seeds. Treat title, description, place descriptions, actor role, rules and layout as public. The prompt requests that the model keep secrets out of these public fields, but structural validation cannot detect a secret restated in public text: a human or a separately designed privacy audit must review it before publication. Do not send the raw draft or another actor's memories or goals to a global or actor observation. Authenticated actor identity and authorization belong to the caller.

## Model call

From the repository root, inject any callable accepting `(system_prompt, user_json)` and returning JSON text:

```python
from luanti.genesis.genesis import generate, GenesisError

def my_model(system_prompt, user_json):
    return provider_call(system_prompt, user_json)  # application-provided

draft = generate('安静的河谷，有一位旅人', my_model)
```

For the existing `luanti.model.adapter` Responses transport, the host supplies an already constructed `Config` and keeps credentials out of logs. Neither genesis nor this bridge reads environment variables or `.env`:

```python
from luanti.genesis.genesis import generate
from luanti.genesis.model_adapter import responses_model
from luanti.model.adapter import Config

config = Config(base_url=provider_url, model=model_name, api_key=credential)
draft = generate('安静的河谷，有一位旅人', responses_model(config))
```

The bridge reuses the existing adapter's bounded HTTPS/SSE transport and parser, currently private APIs; pin or expose those APIs before production integration. It does not use the action-specific `decide` prompt. Provider failures become `GenesisError('model_failed')`; parse and validation failures are `invalid_json` or `invalid_draft` with diagnostics. Generation performs no retries or writes; a provider call occurs only if the caller invokes the configured bridge. The request transmits the intent to the configured provider; the caller controls provider choice and authorization.

## CLI

Run at repository root. The CLI consumes an already obtained model response; it does not contact a model or load credentials. Redirecting output is optional and should target a new draft file, never an active world:

```sh
python3 -m luanti.genesis validate luanti/genesis/example.json
python3 -m luanti.genesis generate --intent '安静的河谷，有一位旅人' --response luanti/genesis/example.json > /path/to/new-draft.json
python3 -m unittest luanti.genesis.test_genesis luanti.genesis.test_store luanti.genesis.test_compiler -v
```

The second command demonstrates the offline interface with a fixture; production callers must provide a response generated for the current intent. Invalid input exits nonzero and prints safe diagnostics to stderr. The CLI does not establish that an arbitrary supplied response matches the intent.

## Luanti compilation plan v1

`compile_plan(draft)` in `luanti.genesis.compiler` is a pure, deterministic conversion into JSON-compatible data. It independently revalidates its input and accepts **1–5 actors**. It never opens files, accepts paths, invokes an engine, writes a world or confirms a draft. The caller must obtain explicit confirmation of the exact draft/revision before applying anything to a runtime; this compiler does not implement that application.

```python
import json
from luanti.genesis.compiler import CompileError, compile_plan, public_plan
from luanti.genesis.store import DraftStore

store = DraftStore('/private/drafts.sqlite')
try:
    record = store.read(draft_id)  # authorized caller; contains private data
    plan = compile_plan(record['draft'])
finally:
    store.close()
# private JSON must be delivered only to an authorized integration service
private_json = json.dumps(plan, ensure_ascii=False, allow_nan=False)
public_json = json.dumps(public_plan(plan), ensure_ascii=False, allow_nan=False)
```

The exact output shape is:

```json
{
  "schema_version": 1,
  "public": {
    "title": "河谷",
    "bounds": {"min": {"x": -32, "y": 1, "z": -32}, "max": {"x": 32, "y": 1, "z": 32}},
    "grid_spacing": 8,
    "places": [{"id": "bank", "name": "河岸", "space": "outdoor", "grid": [0, 0], "anchor": {"x": 0, "y": 1, "z": 0}}],
    "actors": [{"actor_id": "traveler", "ordinal": 0, "name": "旅人", "place_id": "bank", "grid": [0, 0], "position": {"x": 0, "y": 1, "z": 0}}],
    "semantic_connections": []
  },
  "private_actors": {"traveler": {"role": "访客", "goal": "找到住处", "memory_seeds": ["曾在上游遇见一位渔夫。"]}},
  "unsupported": [{"code": "luanti_map_not_integrated"}, {"code": "terrain_and_spawn_safety_unverified"}, {"code": "semantic_connections_not_paths"}, {"code": "character_runtime_not_integrated"}]
}
```

Every object has exactly the fields shown. `places` and `actors` contain 1–16 and 1–5 entries respectively; `grid` is a two-integer `[x,z]` array. Positions, anchors, bounds, grid spacing and ordinals are integers. `ordinal` is the zero-based index of the actor's ASCII ID in sorted order, matching the runtime's numeric ID convention; it is stable under input reordering but can change when actor IDs are added or removed. Persist the complete mapping for an instantiated world and do not recompile a changed roster over live identities. Places are sorted by ID; each place anchor is `(grid[0]*8, 1, grid[1]*8)`. Actors sharing a place are sorted by ID and receive offsets `(0,0), (2,0), (-2,0), (0,2), (0,-2)` in the x/z plane. Place anchors and spawn points must lie inside the inclusive fixed bounds. Collisions or out-of-bounds points are rejected, not relocated. Bounds are the current agent's default horizontal ±32 and `y=1` spawn plane, not a verified physical world volume; integration must configure compatible bounds and independently check terrain, air, clearance, occupancy and safe spawning.

Connections are undirected, normalized to `from < to`, sorted, and represent only semantic relationships. They are not routes, do not promise walkability, and cannot authorize movement through the map. All IDs come from the draft's restricted ASCII ID format, and the plan has no filesystem paths; the integration must independently constrain any paths it chooses. Role, goal and prior memory seeds occur only under the relevant `private_actors` key. `public_plan` returns an independent copy of the public section, excluding all private actors. Structural validation cannot identify a secret that the model copied into a name or other ostensibly public text; review public content before exposure. Never give the full plan or another actor's private entry to a global or actor observation.

`unsupported` always includes the four codes shown, and includes `{"code":"descriptive_rule_not_executed","rule_id":ID}` for every proposed rule, ordered by rule ID. Rule descriptions are not included and no rules execute. `CompileError.code` is `invalid_draft`, `actor_count`, `out_of_bounds`, or `spatial_conflict`; `diagnostics` is a list of safe path/code pairs when available. Invalid references, duplicate IDs/grid cells and path-like IDs are rejected by the draft validator. No partial plan is returned on failure. The resulting format is an integration plan, not the existing Lua persistence schema or proof that terrain, rules, memories or agents were installed.

## Draft storage and explicit confirmation

```python
from luanti.genesis.store import DraftStore, DraftConflict
from luanti.genesis.genesis import generate

store = DraftStore('/private/drafts.sqlite', create=True)  # exclusive creation
try:
    draft = generate(user_intent, model_callable)
    record = store.create(draft)             # id, revision=1, status=draft
    record = store.read(record['id'])        # private author-facing content
    # When editing, use store.update(id, expected_revision, replacement_draft).
    # Only after the user explicitly confirms this exact revision and destination:
    result = store.confirm(record['id'], record['revision'], '/private/new-world.sqlite')
    print(result['unsupported'])
finally:
    store.close()

# After an interrupted confirmation, reopen the same draft database and resume:
store = DraftStore('/private/drafts.sqlite')
try:
    result = store.recover_confirmation(record['id'])
finally:
    store.close()
```

`create` and `update` validate and copy the draft. `update` requires the current revision and increments it; confirmation locks that revision, target path and a unique origin token. Stale revisions, changes after confirmation begins, and attempts to change the target raise `DraftConflict`. `recover_confirmation` requires an earlier explicit confirmation; it cannot confirm an ordinary draft. `confirm` can be retried with the same id, revision and path. It verifies the origin event and full original projection before recognizing an already published world, even if subsequent world events exist. A missing confirmed world fails closed rather than silently recreating it.

Confirmation persists a `pending` request in the draft database, creates and validates a complete `WorldStore` in the destination directory, flushes it, and publishes it with an exclusive hard link. An existing target, including a competing file, is never overwritten. The directory is synced before recording `confirmed`. After interruption, recovery checks the exact original event and snapshots and finishes the pending request, or reports a conflict without changing an unrelated target. If a conflict occupies the target, resolve it externally and retry the same request; there is no implicit retarget or cancellation. Use local filesystems supporting same-directory hard links, directory fsync and SQLite locking. Durability depends on filesystem/hardware honoring sync; this is a recovery protocol across two databases, not a cross-database transaction or backup. A process killed during staging can leave an unreferenced `.genesis-*.sqlite` file in the target directory; it is not a published world. Do not delete a staging file while another process may be using it.

The new WorldStore starts paused at time zero, version 1, with a `genesis.created` origin event. Its `world.genesis` contains title, public description, places and semantic layout, and `map_applied: false`; each character snapshot contains its own goal, starting place ID and memory seeds. These are stored data, not live characters or a Lua cognition schema. The confirmation result reports every descriptive rule as `descriptive_rule_not_implemented`, plus `luanti_map_not_integrated` and `character_runtime_not_integrated`. Rules are not installed or claimed executable. The caller must show these limitations and review private/public content before requesting confirmation. Do not expose raw drafts or character snapshots as global observations.

The draft and world databases both contain private data and must be kept in caller-controlled private directories. `DraftStore` creates its own database with mode 0600; it is not an authorization mechanism. The server must authenticate draft owners, decide who can confirm, retain the user's confirmation of the exact revision, and implement any eventual map projection, conflict handling, rollback and reconciliation. SQLite checkpoints and a Luanti map do not share an atomic transaction. Opening untrusted paths or concurrently allowing third parties to replace files/directories is outside this API's trust boundary.

Reference studied read-only: `proto/world-genesis` at `6b51de516baf94d42d1450f587e37b729bf99677`, especially `prototypes/world-creation.mjs`, `world-genesis.mjs` and `world-definition.mjs`: draft identity/revision checks, world/place/actor references, privacy separation, and no generated fixture fallback inform this smaller contract. This module does not port its compiler, privacy audit, playable rules, or source-retrieval workflow.
