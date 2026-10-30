# World genesis v1

This module generates and persists drafts and can explicitly confirm a particular revision into a new `WorldStore` checkpoint. A valid draft is a bounded, referentially consistent proposal, not an executable Luanti world and not evidence that rules or spatial geometry are implemented. It does not connect to a Luanti map or agent runtime. It never falls back to a canned story after a model failure. `example.json` is only a test and documentation fixture; product-shaped intent cases are recorded under [evidence/luanti/genesis/2026-10-29-product-intents](../evidence/luanti/genesis/2026-10-29-product-intents).

## Contract

[schema.json](schema.json) is the JSON Schema 2020-12 structural contract. All properties are required; unknown properties are rejected. Arrays may be empty where the schema permits. `places` and `actors` have separate ID namespaces; `rules` have their own. Each actor starts at `placeId`; each memory belongs only to its `actorId`. Layout has exactly one entry per place, distinct integer grid coordinates, and undirected connections. Coordinates express relative semantic layout, not Luanti node positions; neither connectivity nor geometry is guaranteed. Rules are descriptive proposals, not code or enforced mechanics.

In addition to JSON Schema, `validate` enforces unique IDs within each collection, valid actor/place/memory references, exact place coverage in layout, distinct grid cells, and valid, non-self, non-duplicate undirected connections. Integers must be actual JSON integer values (not booleans or decimal-form numbers). Text must be nonblank and contain no control characters U+0000–U+001F. JSON input rejects duplicate keys, non-finite values and outputs over 8192 UTF-8 bytes. `generate` also compiles each schema-valid candidate against current Luanti bounds and spawn capacity; bounded retries receive only path/code diagnostics. This applies to generated drafts; later human edits are checked again on preview or publication. Diagnostics contain only paths and codes, not model output.

`public_view(draft)` removes the entire `memories` collection and each actor's goal; `actor_memories(draft, actor_id)` returns only that actor's seeds. Treat title, description, place descriptions, actor role, rules and layout as public. The prompt requests that the model keep secrets out of these public fields, but structural validation cannot detect a secret restated in public text: a human or a separately designed privacy audit must review it before publication. Do not send the raw draft or another actor's memories or goals to a global or actor observation. Authenticated actor identity and authorization belong to the caller.

## Model call

From the repository root, inject any callable accepting `(system_prompt, user_json)` and returning JSON text:

```python
from genesis.genesis import generate, GenesisError

def my_model(system_prompt, user_json):
    return provider_call(system_prompt, user_json)  # application-provided

draft = generate('安静的河谷，有一位旅人', my_model)
```

For the existing `model.adapter` Responses transport, the host supplies an already constructed `Config` and keeps credentials out of logs. Neither genesis nor this bridge reads environment variables or `.env`:

```python
from genesis.genesis import generate
from genesis.model_adapter import responses_model
from model.adapter import Config

config = Config(base_url=provider_url, model=model_name, api_key=credential)
draft = generate('安静的河谷，有一位旅人', responses_model(config))
```

The bridge reuses the existing adapter's bounded HTTPS/SSE transport and parser, currently private APIs; pin or expose those APIs before production integration. It does not use the action-specific `decide` prompt. Provider failures become `GenesisError('model_failed')`. Invalid JSON, schema output, or Luanti-incompatible geometry is retried at most three total calls; retries receive only safe path/code diagnostics from the previous validation, and failure after the final attempt remains `invalid_json` or `invalid_draft`. Known transient provider errors (`transport_error`, `timeout`, `rate_limited`, `provider_failed`, and `incomplete_response`) also receive at most three total calls, with one- and two-second backoff. Other provider errors fail immediately, and raw provider details are never exposed. `responses_model(..., usage_callback=callable)` can report a copy of the adapter's sanitized provider usage for each completed response; missing or invalid usage is not estimated. Generation performs no writes; a provider call occurs only if the caller invokes the configured bridge. The request transmits the intent to the configured provider; the caller controls provider choice and authorization.

`DraftStore.create_from_intent(intent, model)` is the generic persistence entry point. It generates once, stores the exact input intent as private metadata bound to the new draft ID, and returns an editable revision 1. `DraftStore.update` can revise the draft while it remains in `draft` status; `confirm` binds the exact revision and freezes it. The intent is copied only into private creation provenance when `create_world` publishes a product directory. It is never added to `public_view` or the public spatial plan.

## CLI

Run at repository root. The CLI can consume an already obtained model response or call the configured provider with `--live`. Redirect draft export to a private file, never an active world:

```sh
python3 -m genesis validate genesis/example.json
python3 -m genesis generate --intent '安静的河谷，有一位旅人' --response genesis/example.json > /path/to/new-draft.json
python3 -m genesis create-draft --draft-db /private/drafts.sqlite --intent '当前用户的世界描述' --response /private/model-response.json
# 已配置 XUNFEI_* 或 WISPIVA_LLM_* 时，可以直接调用真实模型生成可编辑草稿：
python3 -m genesis create-draft --draft-db /private/drafts.sqlite --intent '当前用户的世界描述' --live
python3 -m genesis read --draft-db /private/drafts.sqlite --draft-id DRAFT_ID --draft-only > /private/draft-review.json
python3 -m genesis edit --draft-db /private/drafts.sqlite --draft-id DRAFT_ID --revision 1 --draft /private/edited-draft.json
python3 -m genesis read --draft-db /private/drafts.sqlite --draft-id DRAFT_ID
python3 -m genesis confirm --draft-db /private/drafts.sqlite --draft-id DRAFT_ID --revision 2 --world-path /private/world.sqlite
python3 -m genesis create-world --draft-db /private/drafts.sqlite --draft-id DRAFT_ID --revision 2 --world-path /private/luanti-world
python3 -m genesis save --draft-db /private/drafts.sqlite --draft /path/to/new-draft.json
python3 -m genesis read --draft-db /private/drafts.sqlite --draft-id DRAFT_ID
python3 -m genesis confirm --draft-db /private/drafts.sqlite --draft-id DRAFT_ID --revision 1 --world-path /private/world.sqlite
python3 -m genesis preflight --draft-db /private/drafts.sqlite --draft-id DRAFT_ID --revision 1 --world-path /private/next-world.sqlite
python3 -m genesis create-world --draft-db /private/drafts.sqlite --draft-id DRAFT_ID --revision 1 --world-path /private/luanti-world
python3 -m unittest genesis.test_genesis genesis.test_store genesis.test_compiler genesis.test_preflight genesis.test_preview -v
```

`generate` 仍消费已经取得的模型响应；`create-draft` 默认也消费响应文件，使用 `--live` 时才读取显式配置并调用真实 provider。两种路径都只生成可编辑草稿，不会自动确认或创建世界。`read` 导出完整草稿供检查，`edit` 使用 expected revision 替换草稿并增加 revision；stale edit、已确认草稿编辑都会失败。用户随后可检查新 revision 并明确确认它。响应必须针对当前 intent 生成。无效输入以非零状态退出并向 stderr 输出安全诊断；结构校验和 intent 绑定不能代替用户检查公开／私有预览及语义一致性确认。

`create-world` is the persistent product path. It requires the exact confirmed
draft revision and its unchanged origin checkpoint, then publishes a
Luanti world directory with a stable `wispiva-world-id`, private
`private/wispiva-origin.json`, a copied origin checkpoint, projection materials,
and server configuration. It uses a same-parent atomic directory rename. A
retry against an existing target is accepted only if its identity, manifest,
contract, creation record, origin copy and runtime entrypoints match that exact
confirmed request; unrelated or damaged targets are rejected without writes.
A staged directory is retained after a failure for inspection. The manifest contains private actor roles, goals and genesis
seeds, plus the original intent and its digest when the draft was created through
`create_from_intent`, so the directory and every copy of it remain private. Start a created
world with `engine/luanti/run_product.sh`; the product runtime projects places
and connections, injects only each actor's own profile into its model request,
and records environment changes as world events. `preview` remains disposable.

## Luanti compilation plan v1

`compile_plan(draft)` in `genesis.compiler` is a pure, deterministic conversion into JSON-compatible data. It independently revalidates its input and accepts **1–5 actors**. It never opens files, accepts paths, invokes an engine, writes a world or confirms a draft. The caller must obtain explicit confirmation of the exact draft/revision before applying anything to a runtime; this compiler does not implement that application.

```python
import json
from genesis.compiler import CompileError, compile_plan, public_plan
from genesis.store import DraftStore

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

## Runtime preflight: deliberately blocked

Persistent-world integration remains blocked. After explicit `DraftStore.confirm(id, revision, world_checkpoint_path)` has completed, an authorized service can call:

```python
from genesis.store import DraftStore
from genesis.preflight import preflight, PreflightError

store = DraftStore('/private/drafts.sqlite')
try:
    result = preflight(store, draft_id, revision, '/private/new-luanti-world')
finally:
    store.close()
assert result['status'] == 'blocked' and result['launchable'] is False
# result['plan'] contains private_actors and must stay private.
```

`preflight` checks the exact confirmed ID and revision, recompiles the draft, replays the confirmed `WorldStore` via a read-only SQLite connection, checks its initial event and full snapshot against that draft, requires world version 1, and checks that the proposed absolute runtime path currently does not exist. It rejects description-only rules, indoor places, semantic connections and invalid/out-of-bounds layouts. The path check neither reserves the path nor protects against concurrent replacement; a future launcher must atomically create an independent directory and revalidate all inputs at the point of use. The caller must control the store and directories and prevent untrusted concurrent replacement.

Success returns `{draft_id, revision, world_path, status: "blocked", launchable: false, plan, blockers}`. The blockers explicitly identify missing cross-store crash recovery, per-character private runtime projection, terrain/spawn verification and runtime world creation. The return is a review artifact, **not permission or a token to launch**. Errors raise `PreflightError` with a safe `code` and optional path/code diagnostics. A pending or unconfirmed draft, stale revision, occupied runtime path, changed/corrupt origin or unsupported draft fails closed. No world is created and no Luanti files or settings are changed.

`WorldStore` and Luanti's map and normal-shutdown character/long-term checkpoint cannot currently commit atomically or reconcile after a crash. The existing runtime also supplies one global goal rather than verified per-actor private goals, roles and seeds. A complete integration needs an explicit recoverable authority/commit protocol, retained draft-to-ordinal identity, fail-closed launch and restore, private per-actor model projection, and terrain/spawn checks. Until those exist, do not use this preflight result to launch or resume a persistent world. The separate disposable preview below does not bypass these persistent-world blockers. Long-term memory and existing restore behavior remain unchanged.

## Disposable Luanti preview

This separate path is **one-shot and disposable**, not a persistent-world integration or a restore. It uses `preflight` to verify the confirmed draft and initial WorldStore, but does not treat its `launchable: false` result as persistent-launch permission. It never writes back to the draft or WorldStore. Create a private root first, then explicitly invoke (engine execution requires the resource coordination established by the user):

```sh
install -d -m 700 /absolute/private/preview-root
python3 -m genesis.preview --draft-db /private/drafts.sqlite \
  --draft-id DRAFT_ID --revision REVISION --preview-root /absolute/private/preview-root --fixture
```

Omit `--fixture` to use the existing model bridge and its caller-provided environment. The preview-specific fixture emits deterministic say, wander and advance decisions with `origin=fixture`; it does not call a real model. Say requires another actor in observation range; a one-actor preview cannot demonstrate conversation. `LUANTI_RT` chooses the existing runtime root (default `engine/luanti/.runtime`), `--port` defaults to 30077 and `--seconds` defaults to 180. The launcher creates a unique mode-0700 directory and mode-0600 manifest after checking the root is owned by the caller and inaccessible to group/others; a conflict never overwrites an existing path. The root contains a `world/` directory; the all-actor manifest and model spool reside under `world/private/`, outside the mod media tree. This allows Luanti mod security to access its own world files without granting trusted-mod access. The manifest is mode 0600 and private directories are mode 0700; the engine and worker inherit umask 077 for their temporary requests, responses and logs. The draft database and origin checkpoint must each be owned by the caller with mode 0600 and have a caller-owned parent inaccessible to group/others. Existing source files are never removed or overwritten. The entire preview, including incomplete or abandoned private requests and temporary files, is retained after success, failure or interruption; the owner must remove it after confirming no process is using it. It must not be resumed or treated as a committed world. The caller must avoid concurrent engines and coordinate heavy execution.

Only confirmed exact revisions with 1–5 actors, no descriptive rules, no connections, no indoor places and compiler-valid coordinates are accepted. At most eight seeds per actor and 4096 bytes of encoded private profile are accepted; over-limit input is rejected rather than truncated. The runtime creates a uniform grass plane and uses compiled spawn positions. Places are represented only by their grid coordinates: names/descriptions, structures, terrain features, and connectivity are not rendered. Spawn feet/head and ground are checked after emergence; this does not implement general terrain/path validation. Descriptive rules and space types outside this subset are rejected. The launcher disables persistence, restore and long-term memory for this disposable preview; the pre-existing default and long-term paths remain unchanged. Actors receive normal local observations and can inspect, move, approach and address a nearby actor. A successful say delivers its text only to the sender and named recipient, and the recipient receives it in its inbox and episodic memory. Preview speech is shown above the speaker in visual mode; the event log records a digest, not the text. Actors may deliberately reveal their own private information through say or behavior. Mark, gather and build are rejected with an explicit `preview-world-write-unsupported` result and logged as rejected; the next request carries the failure as immediate feedback. The decision is not rewritten as an inspect action. Each actor's `goal`, `role` and full `memory_seeds` are copied only to its own model context as `goal` and `genesis_profile`. These seeds are prompt context, not durable episodic or long-term records. Public text may still contain secrets mistakenly authored there and needs human review. Outgoing model requests transmit the current actor’s profile to the configured provider; the provider can retain or correlate requests. Private profiles are not directly injected into another actor’s prompt, but voluntary speech and observable actions can communicate information. Local protections do not constrain a malicious same-user process, a provider that discloses data, or a user who has placed private text in publicly visible fields.

The launcher binds the server to localhost and enables the visual character settings; a local Luanti client can be used to view the three-dimensional preview, subject to the engine/client validation below. The launcher leaves Luanti mod security enabled and keeps private files inside the world directory, outside the mod media tree. Real client media behavior still needs engine verification. The launcher monitors the worker and engine, enforces a timeout, checks the preview marker, successful completion and spawn liveness in the log, and returns nonzero on failure. It stops only its own children. It is not a cross-process security boundary against other processes running as the same user, and path availability is rechecked by exclusive creation, not reserved by preflight. The real Luanti engine, its secure-file access to the private manifest, client media enumeration, emergence, rendering, networking and cleanup have not been tested by this implementation's lightweight tests; run those centrally before relying on the preview.

## Draft storage and explicit confirmation

```python
from genesis.store import DraftStore, DraftConflict
from genesis.genesis import generate

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
