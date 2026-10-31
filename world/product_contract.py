"""Versioned identity and startup contract for a persistent Wispiva product world."""
from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import stat
import sqlite3
import uuid

from engine.luanti.world_identity import read_world_identity

FORMAT = "wispiva-product-contract"
VERSION = 2
LEGACY_VERSION = 1
COMPONENTS = ("map", "actors", "inventory", "events", "memory", "environment")


class ProductContractError(ValueError):
    """A product world cannot be safely associated with its persisted state."""


def _text(value, name):
    if type(value) is not str or not value:
        raise ProductContractError("invalid_" + name)
    return value


def _uuid(value, name):
    try:
        if type(value) is not str or str(uuid.UUID(value)) != value:
            raise ValueError
    except (ValueError, AttributeError):
        raise ProductContractError("invalid_" + name) from None
    return value


def _integer(value, name, minimum=0):
    if type(value) is not int or value < minimum:
        raise ProductContractError("invalid_" + name)
    return value


def build_contract(manifest):
    """Derive the immutable creation identity and initial component state."""
    if type(manifest) is not dict:
        raise ProductContractError("invalid_manifest")
    required = ("world_id", "origin_event_id", "draft_id", "revision", "draft_sha256")
    if any(key not in manifest for key in required):
        raise ProductContractError("contract_fields")
    world_id = _uuid(manifest["world_id"], "world_id")
    origin_event_id = _text(manifest["origin_event_id"], "origin_event_id")
    draft_id = _text(manifest["draft_id"], "draft_id")
    revision = _integer(manifest["revision"], "revision", 1)
    draft_sha256 = _text(manifest["draft_sha256"], "draft_sha256")
    if len(draft_sha256) != 64:
        raise ProductContractError("invalid_draft_sha256")
    operation_id = manifest.get("operation_id")
    contract_version = VERSION if operation_id is not None else LEGACY_VERSION
    result = {
        "format": FORMAT,
        "version": contract_version,
        "world_id": world_id,
        "origin_event_id": origin_event_id,
        "draft_id": draft_id,
        "revision": revision,
        "draft_sha256": draft_sha256,
        "phase": "READY",
        "commit_version": 0,
        "components": {name: 0 for name in COMPONENTS},
    }
    if operation_id is not None:
        if (type(operation_id) is not str or len(operation_id) != 32
                or any(char not in "0123456789abcdef" for char in operation_id)):
            raise ProductContractError("invalid_operation_id")
        result["operation_id"] = operation_id
    return result


def validate_contract(value, *, expected_world_id=None, expected_origin_event_id=None):
    """Validate a contract without changing any state."""
    if type(value) is not dict:
        raise ProductContractError("invalid_contract")
    expected = {
        "format", "version", "world_id", "origin_event_id", "draft_id",
        "revision", "draft_sha256", "phase", "commit_version", "components",
    }
    if set(value) not in (expected, expected | {"operation_id"}):
        raise ProductContractError("contract_fields")
    if value["format"] != FORMAT or value["version"] not in (LEGACY_VERSION, VERSION):
        raise ProductContractError("contract_version")
    _uuid(value["world_id"], "world_id")
    _text(value["origin_event_id"], "origin_event_id")
    _text(value["draft_id"], "draft_id")
    _integer(value["revision"], "revision", 1)
    _text(value["draft_sha256"], "draft_sha256")
    if len(value["draft_sha256"]) != 64:
        raise ProductContractError("invalid_draft_sha256")
    if value["version"] == VERSION:
        if "operation_id" not in value:
            raise ProductContractError("contract_operation_missing")
        operation_id = value["operation_id"]
        if (type(operation_id) is not str or len(operation_id) != 32
                or any(char not in "0123456789abcdef" for char in operation_id)):
            raise ProductContractError("invalid_operation_id")
    elif "operation_id" in value:
        raise ProductContractError("contract_operation_version")
    if value["phase"] not in ("READY", "PREPARING", "FROZEN"):
        raise ProductContractError("contract_phase")
    _integer(value["commit_version"], "commit_version")
    if type(value["components"]) is not dict or set(value["components"]) != set(COMPONENTS):
        raise ProductContractError("contract_components")
    for name in COMPONENTS:
        _integer(value["components"][name], "component_" + name)
    if expected_world_id is not None and value["world_id"] != expected_world_id:
        raise ProductContractError("world_id_mismatch")
    if expected_origin_event_id is not None and value["origin_event_id"] != expected_origin_event_id:
        raise ProductContractError("origin_event_mismatch")
    return value


def _read_private_json(path):
    if path.is_symlink() or not path.is_file():
        raise ProductContractError("missing_contract")
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode & 0o077:
            raise ProductContractError("contract_permissions")
        raw = path.read_text(encoding="utf-8")
        value = _strict_json(raw)
    except ProductContractError:
        raise
    except (OSError, UnicodeError, ValueError, TypeError):
        raise ProductContractError("invalid_contract") from None
    return value


def validate_world_contract(world_dir, *, expected_world_id=None):
    """Fail closed before Luanti starts if the private identity bundle diverges."""
    world_dir = Path(world_dir)
    try:
        identity = read_world_identity(world_dir)
    except (OSError, UnicodeError, ValueError):
        raise ProductContractError("missing_world_identity") from None
    _uuid(identity, "world_id")
    if expected_world_id is not None and identity != expected_world_id:
        raise ProductContractError("world_id_mismatch")
    contract = validate_contract(
        _read_private_json(world_dir / "private" / "wispiva-contract.json"),
        expected_world_id=identity,
    )
    manifest = _read_private_json(world_dir / "private" / "wispiva-origin.json")
    if type(manifest) is not dict or manifest.get("contract") != contract:
        raise ProductContractError("manifest_contract_mismatch")
    if manifest.get("world_id") != identity:
        raise ProductContractError("manifest_world_id_mismatch")
    creation = _read_private_json(world_dir / "private" / "creation.json")
    if (type(creation) is not dict
            or creation.get("manifest") != "private/wispiva-origin.json"
            or creation.get("contract") != "private/wispiva-contract.json"
            or creation.get("world_id") != identity
            or creation.get("origin_event_id") != contract["origin_event_id"]):
        raise ProductContractError("creation_contract_mismatch")
    if creation.get("version") == 2:
        operation_id = creation.get("operation_id")
        if (not operation_id or operation_id != contract.get("operation_id")
                or operation_id != manifest.get("operation_id")
                or manifest.get("format") != "wispiva-world-manifest"
                or manifest.get("version") != 2):
            raise ProductContractError("creation_operation_mismatch")
        _validate_canonical_origin(world_dir, manifest, contract)
    elif "operation_id" in contract or "operation_id" in manifest:
        raise ProductContractError("creation_version_mismatch")
    return contract


def _strict_json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError("duplicate key")
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()))


def _validate_canonical_origin(world_dir, manifest, contract):
    """Rebuild genesis from its private source and compare the read-only origin DB."""
    draft = manifest.get("origin_draft")
    if type(draft) is not dict:
        raise ProductContractError("missing_origin_draft")
    try:
        from genesis.compiler import compile_plan
        from genesis.store import _check_draft, _projection
        from genesis.world_create import _runtime_actors

        draft_payload = _check_draft(draft)
        digest = hashlib.sha256(draft_payload.encode("utf-8")).hexdigest()
        if digest != contract["draft_sha256"]:
            raise ProductContractError("origin_draft_digest_mismatch")
        plan = compile_plan(draft)
        if manifest.get("public") != plan["public"]:
            raise ProductContractError("origin_public_projection_mismatch")
        if manifest.get("actors") != _runtime_actors(plan):
            raise ProductContractError("origin_actor_projection_mismatch")
        event = manifest.get("origin_event")
        if (type(event) is not dict or event.get("type") != "genesis.created"
                or event.get("id") != contract["origin_event_id"]):
            raise ProductContractError("origin_event_mismatch")
        event_id = event.get("id")
        if type(event_id) is not str or not event_id.startswith("genesis:"):
            raise ProductContractError("origin_event_mismatch")
        token = event_id[len("genesis:"):]
        if (len(token) != 32 or any(char not in "0123456789abcdef" for char in token)):
            raise ProductContractError("origin_event_mismatch")
        expected_world, expected_characters, expected_event = _projection(
            draft, contract["draft_id"], contract["revision"], token)
        if event != expected_event:
            raise ProductContractError("origin_event_mismatch")

        origin_path = Path(world_dir) / "private" / "origin.sqlite"
        if origin_path.is_symlink() or not origin_path.is_file():
            raise ProductContractError("missing_origin_store")
        if stat.S_IMODE(origin_path.stat().st_mode) & 0o077:
            raise ProductContractError("origin_store_permissions")
        db = sqlite3.connect(origin_path.absolute().as_uri() + "?mode=ro", uri=True)
        try:
            if (db.execute("PRAGMA user_version").fetchone() != (1,)
                    or db.execute("PRAGMA quick_check").fetchone() != ("ok",)):
                raise ProductContractError("invalid_origin_store")
            checkpoints = db.execute(
                "SELECT version,snapshot FROM checkpoint WHERE singleton=1").fetchall()
            rows = db.execute(
                "SELECT version,event_id,request,result FROM events ORDER BY version").fetchall()
            if len(checkpoints) != 1 or len(rows) != 1:
                raise ProductContractError("origin_store_not_creation_only")
            version, snapshot_raw = checkpoints[0]
            event_version, event_id, request_raw, result_raw = rows[0]
            request = _strict_json(request_raw)
            snapshot = _strict_json(snapshot_raw)
            result = _strict_json(result_raw)
            expected_request = {"event": expected_event, "expected_version": 0,
                                "world": expected_world, "characters": expected_characters,
                                "elapsed": 0, "paused": None}
            expected_snapshot = {"world": expected_world, "characters": expected_characters,
                                 "clock": {"time": 0, "paused": True}}
            if (version != 1 or event_version != 1 or event_id != expected_event["id"]
                    or request != expected_request or result != {"version": 1, "event_id": event_id}
                    or snapshot != expected_snapshot):
                raise ProductContractError("origin_store_binding_mismatch")
        finally:
            db.close()
    except ProductContractError:
        raise
    except (OSError, sqlite3.Error, UnicodeError, ValueError, TypeError, KeyError,
            ImportError, RecursionError):
        raise ProductContractError("invalid_origin_store") from None


__all__ = ["FORMAT", "VERSION", "COMPONENTS", "ProductContractError",
           "build_contract", "validate_contract", "validate_world_contract"]
