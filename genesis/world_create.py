"""Create a confirmed Wispiva world as an atomic Luanti world directory.

The draft confirmation and its origin SQLite store remain the source record for
user intent.  This module publishes a separate Luanti world only after it has
validated that record, and never replaces an existing directory.  The private
manifest is the runtime hand-off: it contains the public spatial plan and the
per-actor private seed material needed by cognition.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

from genesis.compiler import CompileError, compile_plan
from genesis.store import DraftCorrupt, DraftStore
from engine.luanti.world_session import WorldSession
from world.product_contract import build_contract
from world.store import CorruptStore, WorldStore


ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "engine" / "luanti"
COGNITION = ROOT / "cognition"
MOD = ENGINE / "mod" / "society"


class WorldCreationError(ValueError):
    """The confirmed draft cannot be published as a product world."""

    def __init__(self, code: str, diagnostics=()):
        super().__init__(code)
        self.code = code
        self.diagnostics = list(diagnostics)


def _sync_dir(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_private(path: Path, value) -> None:
    payload = (json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        raise


def _origin_state(path: Path):
    if path.is_symlink() or not path.is_file():
        raise WorldCreationError("confirmed_world_missing")
    try:
        store = WorldStore(path)
        try:
            state = store.recover()
        finally:
            store.close()
    except (OSError, CorruptStore, ValueError):
        raise WorldCreationError("confirmed_world_invalid") from None
    if state["version"] != 1 or len(state["events"]) != 1:
        raise WorldCreationError("origin_already_advanced")
    event = state["events"][0]["event"]
    if event.get("type") != "genesis.created":
        raise WorldCreationError("origin_event_invalid")
    return state, event


def _runtime_actors(plan):
    actors = []
    for public in plan["public"]["actors"]:
        private = plan["private_actors"][public["actor_id"]]
        actors.append({
            "runtime_id": public["ordinal"],
            "actor_id": public["actor_id"],
            "name": public["name"],
            "place_id": public["place_id"],
            "position": copy.deepcopy(public["position"]),
            "role": private["role"],
            "goal": private["goal"],
            "memory_seeds": [
                {"seed_id": "genesis:seed:%s:%d" % (public["actor_id"], index),
                 "text": text, "source": {"kind": "genesis.seed"}}
                for index, text in enumerate(private["memory_seeds"])
            ],
        })
    return actors


def build_manifest(row, plan, event, world_id):
    """Build the detached runtime manifest without writing any files."""
    if not isinstance(world_id, str) or not world_id:
        raise WorldCreationError("invalid_world_id")
    digest = event.get("data", {}).get("draft_sha256")
    if not isinstance(digest, str) or not digest:
        raise WorldCreationError("origin_digest_missing")
    manifest = {
        "format": "wispiva-world-manifest",
        "version": 1,
        "world_id": world_id,
        "draft_id": row["id"],
        "revision": row["revision"],
        "draft_sha256": digest,
        "origin_event_id": event["id"],
        "logic_clock": {"time": 0, "paused": False},
        "public": copy.deepcopy(plan["public"]),
        "actors": _runtime_actors(plan),
        "origin_event": copy.deepcopy(event),
    }
    # The original user input is private creation provenance. It is retained
    # beside the runtime hand-off and never included in the public spatial view.
    if row.get("intent") is not None:
        manifest["intent"] = row["intent"]
        manifest["intent_sha256"] = hashlib.sha256(
            row["intent"].encode("utf-8")).hexdigest()
    manifest["contract"] = build_contract(manifest)
    return manifest


def _install_runtime(stage: Path, manifest_path: Path) -> None:
    world = stage
    (world / "worldmods" / "society").mkdir(parents=True, mode=0o700)
    private = world / "private"
    private.mkdir(mode=0o700, exist_ok=True)
    for source in MOD.glob("*.lua"):
        shutil.copyfile(source, world / "worldmods" / "society" / source.name)
    for source in COGNITION.glob("*.lua"):
        if source.name.startswith("test_") or source.name == "test.lua":
            continue
        shutil.copyfile(source, world / "worldmods" / "society" / source.name)
    _write_private(private / "wispiva-origin.json", json.loads(manifest_path.read_text(encoding="utf-8")))
    (world / "world.mt").write_text(
        "gameid = minetest_game\nbackend = sqlite3\nload_mod_society = true\n",
        encoding="utf-8")
    (world / "server.conf").write_text(
        "bind_address = 127.0.0.1\n"
        "mg_name = singlenode\n"
        "server_announce = false\n"
        "enable_damage = false\n"
        "creative_mode = true\n"
        "max_forceloaded_blocks = -1\n"
        "static_spawnpoint = (0,2,-20)\n"
        "society_world_product = true\n"
        "society_genesis_manifest = %s\n"
        "society_visual = true\n"
        "society_cognition = true\n"
        "society_model = true\n"
        "society_persist = true\n"
        "society_restore = false\n" % (private / "wispiva-origin.json"),
        encoding="utf-8")


def create_world(store: DraftStore, draft_id: str, revision: int, target) -> dict:
    """Publish a confirmed draft to a new Luanti world directory.

    Retries are idempotent only when the target already contains the same
    manifest.  Existing unrelated directories are rejected before any write.
    """
    target = Path(target)
    if not target.is_absolute() or target.name in ("", ".", ".."):
        raise WorldCreationError("invalid_world_path")
    if target.exists() or target.is_symlink():
        raise WorldCreationError("runtime_path_exists")
    try:
        row = store._row(draft_id)
    except (KeyError, DraftCorrupt):
        raise WorldCreationError("confirmation_not_found") from None
    if row["status"] != "confirmed" or row["revision"] != revision:
        raise WorldCreationError("confirmation_mismatch")
    try:
        plan = compile_plan(row["draft"])
    except CompileError as error:
        raise WorldCreationError(error.code, error.diagnostics) from None
    _, event = _origin_state(Path(row["target"]))
    if event["data"].get("draft_id") != row["id"] or event["data"].get("revision") != row["revision"]:
        raise WorldCreationError("origin_binding_mismatch")
    parent = target.parent
    if not parent.is_dir():
        raise WorldCreationError("invalid_world_parent")
    stage = Path(tempfile.mkdtemp(prefix=".wispiva-world-", dir=parent))
    os.chmod(stage, 0o700)
    try:
        with WorldSession(stage, create=True) as session:
            manifest = build_manifest(row, plan, event, session.world_id)
        (stage / "private").mkdir(mode=0o700)
        manifest_path = stage / "private" / ".manifest-source.json"
        # Keep this intermediate file private and remove it after installation;
        # the published copy is written through the same private writer.
        _write_private(manifest_path, manifest)
        _install_runtime(stage, manifest_path)
        manifest_path.unlink()
        _write_private(stage / "private" / "wispiva-contract.json", manifest["contract"])
        shutil.copyfile(Path(row["target"]), stage / "private" / "origin.sqlite")
        os.chmod(stage / "private" / "origin.sqlite", 0o600)
        _write_private(stage / "private" / "creation.json", {
            "format": "wispiva-world-creation", "version": 1,
            "world_id": manifest["world_id"], "draft_id": row["id"],
            "revision": row["revision"], "origin_event_id": event["id"],
            "manifest": "private/wispiva-origin.json",
            "contract": "private/wispiva-contract.json",
            "world_id": manifest["world_id"],
            "origin_event_id": manifest["origin_event_id"],
            "intent_sha256": manifest.get("intent_sha256"),
        })
        _sync_dir(stage / "private")
        _sync_dir(stage)
        os.rename(stage, target)
        _sync_dir(parent)
        return {
            "status": "created", "world_path": str(target),
            "world_id": manifest["world_id"], "draft_id": row["id"],
            "revision": row["revision"], "origin_event_id": event["id"],
            "actor_count": len(manifest["actors"]),
        }
    except BaseException:
        # Retain the staged directory for inspection; never remove evidence
        # after a failure that may have happened after publication of a file.
        raise


__all__ = ["WorldCreationError", "build_manifest", "create_world"]
