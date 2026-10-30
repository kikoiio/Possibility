"""Authenticated host boundary for turning an L2 proposal into a record.

The provider bridge only proposes text and source IDs.  This module keeps the
caller-owned persistence step explicit: the caller must select an actor-private
request and provide an append callback backed by the authoritative memory
store.  The callback is invoked exactly once, and only after provider output
has passed the source-grounded contract.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from . import adapter
from .reflection import ReflectionError, reflect


class ReflectionHostError(ValueError):
    """The host request or persistence result violated the writeback contract."""


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ReflectionHostError("invalid_" + name)
    return value


def _validate_record(record: Any, *, actor_id: str, topic: str,
                     source_ids: list[str]) -> dict[str, Any]:
    if type(record) is not dict:
        raise ReflectionHostError("invalid_persisted_record")
    if record.get("layer") != "L2" or record.get("owner") != actor_id:
        raise ReflectionHostError("invalid_persisted_record")
    if record.get("topic") != topic:
        raise ReflectionHostError("invalid_persisted_record")
    experiences = record.get("experiences")
    if type(experiences) is not list or experiences != source_ids:
        raise ReflectionHostError("invalid_persisted_record")
    _text(record.get("id"), "persisted_id")
    return dict(record)


def reflect_and_persist(
    config: adapter.Config,
    request: Mapping[str, Any],
    append: Callable[[str, str, list[str], str, float, str], Mapping[str, Any]],
    *,
    time: float,
    source_id: str = "model-reflection",
    transport: Callable[[adapter.Config, bytes], bytes] | None = None,
) -> dict[str, Any]:
    """Generate one private reflection and append it to the authoritative store.

    ``append`` is intentionally supplied by the host instead of imported here;
    this prevents the provider bridge from inventing memory ownership or
    bypassing the runtime's authenticated Lua store.
    """
    if type(request) is not dict:
        raise ReflectionHostError("invalid_request")
    raw_request = request.get("request")
    if type(raw_request) is not dict:
        raise ReflectionHostError("invalid_request")
    actor_id = _text(raw_request.get("actor_id"), "actor_id")
    topic = _text(raw_request.get("topic"), "topic")
    if type(time) not in (int, float) or isinstance(time, bool):
        raise ReflectionHostError("invalid_time")
    source_id = _text(source_id, "source_id")
    try:
        result = reflect(config, request, transport=transport)
    except ReflectionError:
        raise
    proposal = result["reflection"]
    source_ids = list(proposal["source_ids"])
    try:
        persisted = append(actor_id, topic, source_ids, proposal["text"], time, source_id)
    except Exception as exc:
        raise ReflectionHostError("persist_failed") from exc
    record = _validate_record(persisted, actor_id=actor_id, topic=topic,
                              source_ids=source_ids)
    return {"reflection": proposal, "persisted": record, "audit": result["audit"]}


__all__ = ["ReflectionHostError", "reflect_and_persist"]
