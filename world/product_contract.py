"""Versioned identity and startup contract for a persistent Wispiva product world."""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import uuid

FORMAT = "wispiva-product-contract"
VERSION = 1
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
    return {
        "format": FORMAT,
        "version": VERSION,
        "world_id": world_id,
        "origin_event_id": origin_event_id,
        "draft_id": draft_id,
        "revision": revision,
        "draft_sha256": draft_sha256,
        "phase": "READY",
        "commit_version": 0,
        "components": {name: 0 for name in COMPONENTS},
    }


def validate_contract(value, *, expected_world_id=None, expected_origin_event_id=None):
    """Validate a contract without changing any state."""
    if type(value) is not dict:
        raise ProductContractError("invalid_contract")
    expected = {
        "format", "version", "world_id", "origin_event_id", "draft_id",
        "revision", "draft_sha256", "phase", "commit_version", "components",
    }
    if set(value) != expected:
        raise ProductContractError("contract_fields")
    if value["format"] != FORMAT or value["version"] != VERSION:
        raise ProductContractError("contract_version")
    _uuid(value["world_id"], "world_id")
    _text(value["origin_event_id"], "origin_event_id")
    _text(value["draft_id"], "draft_id")
    _integer(value["revision"], "revision", 1)
    _text(value["draft_sha256"], "draft_sha256")
    if len(value["draft_sha256"]) != 64:
        raise ProductContractError("invalid_draft_sha256")
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
        value = json.loads(raw)
    except ProductContractError:
        raise
    except (OSError, UnicodeError, ValueError, TypeError):
        raise ProductContractError("invalid_contract") from None
    return value


def validate_world_contract(world_dir, *, expected_world_id=None):
    """Fail closed before Luanti starts if the private identity bundle diverges."""
    world_dir = Path(world_dir)
    identity_path = world_dir / "wispiva-world-id"
    try:
        identity = identity_path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeError):
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
    return contract


__all__ = ["FORMAT", "VERSION", "COMPONENTS", "ProductContractError",
           "build_contract", "validate_contract", "validate_world_contract"]