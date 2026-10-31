import json
import tempfile
import unittest
from pathlib import Path

from genesis.store import DraftStore, DraftConflict
from genesis.test_genesis import draft
from genesis.world_create import WorldCreationError, create_world
from engine.luanti.world_identity import read_world_identity
from world.product_contract import ProductContractError, validate_world_contract


class WorldCreateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = DraftStore(self.root / "drafts.sqlite", create=True)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def confirmed(self, value=None):
        row = self.store.create(draft() if value is None else value)
        self.store.confirm(row["id"], row["revision"], self.root / (row["id"] + ".sqlite"))
        return row

    def test_publishes_identity_manifest_runtime_and_origin(self):
        row = self.confirmed()
        target = self.root / "worlds" / "river-world"
        target.parent.mkdir()
        result = create_world(self.store, row["id"], row["revision"], target)
        self.assertEqual(result["status"], "created")
        self.assertEqual(result["actor_count"], 1)
        self.assertEqual(read_world_identity(target), result["world_id"])
        manifest_path = target / "private" / "wispiva-origin.json"
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(manifest["world_id"], result["world_id"])
        self.assertEqual(manifest["origin_event_id"], result["origin_event_id"])
        self.assertEqual(manifest["public"]["title"], row["draft"]["title"])
        self.assertEqual(manifest["public"]["description"], row["draft"]["description"])
        self.assertEqual(manifest["origin_draft"], row["draft"])
        self.assertEqual(manifest["version"], 2)
        self.assertEqual(len(manifest["operation_id"]), 32)
        self.assertEqual(manifest["actors"][0]["memory_seeds"][0]["text"], "私人的经历")
        self.assertTrue((target / "worldmods" / "society" / "init.lua").is_file())
        self.assertTrue((target / "server.conf").is_file())
        self.assertTrue((target / "private" / "origin.sqlite").is_file())
        self.assertEqual((target / "private" / "wispiva-origin.json").stat().st_mode & 0o777, 0o600)
        contract = validate_world_contract(target, expected_world_id=result["world_id"])
        self.assertEqual(contract["operation_id"], result["operation_id"])
        publication = self.store.product_publication(row["id"], row["revision"])
        self.assertEqual(publication["state"], "PUBLISHED")
        self.assertEqual(publication["operation_id"], result["operation_id"])

    def test_exact_published_world_retry_returns_same_result_without_writes(self):
        row = self.confirmed()
        target = self.root / "world"
        target.parent.mkdir(exist_ok=True)
        first = create_world(self.store, row["id"], row["revision"], target)
        manifest = target / "private" / "wispiva-origin.json"
        before = manifest.read_bytes()
        retried = create_world(self.store, row["id"], row["revision"], target)
        self.assertTrue(retried.pop("idempotent"))
        self.assertEqual(retried, first)
        self.assertEqual(manifest.read_bytes(), before)
        self.assertEqual(retried["operation_id"], first["operation_id"])

    def test_existing_world_with_different_confirmation_is_never_replaced(self):
        original = self.confirmed()
        other = self.confirmed()
        target = self.root / "world"
        target.parent.mkdir(exist_ok=True)
        create_world(self.store, original["id"], original["revision"], target)
        manifest = target / "private" / "wispiva-origin.json"
        before = manifest.read_bytes()
        with self.assertRaises(WorldCreationError) as error:
            create_world(self.store, other["id"], other["revision"], target)
        self.assertEqual(error.exception.code, "existing_world_conflict")
        self.assertEqual(manifest.read_bytes(), before)
        publication = self.store.product_publication(other["id"], other["revision"])
        self.assertEqual(publication["state"], "FROZEN")

    def test_existing_target_is_never_replaced(self):
        row = self.confirmed()
        target = self.root / "world"
        target.mkdir()
        marker = target / "marker"
        marker.write_text("keep")
        with self.assertRaises(WorldCreationError) as error:
            create_world(self.store, row["id"], row["revision"], target)
        self.assertEqual(error.exception.code, "existing_world_conflict")
        self.assertEqual(marker.read_text(), "keep")

    def test_stale_confirmation_and_advanced_origin_fail_closed(self):
        row = self.confirmed()
        target = self.root / "world"
        with self.assertRaises(WorldCreationError) as error:
            create_world(self.store, row["id"], row["revision"] + 1, target)
        self.assertEqual(error.exception.code, "confirmation_mismatch")

        origin = Path(self.store.read(row["id"])["target"])
        # Use the public store API to make the origin no longer a creation-only
        # checkpoint. The product creator must reject it before staging.
        from world.store import WorldStore
        world = WorldStore(origin)
        try:
            state = world.recover()
            world.commit({"id": "after-origin", "type": "changed", "data": {}}, 1,
                         state["world"], state["characters"])
        finally:
            world.close()
        with self.assertRaises(WorldCreationError) as error:
            create_world(self.store, row["id"], row["revision"], target)
        self.assertEqual(error.exception.code, "origin_already_advanced")
        self.assertFalse(target.exists())

    def test_unknown_stage_freezes_and_does_not_publish(self):
        row = self.confirmed()
        target = self.root / "world"
        target.parent.mkdir(exist_ok=True)
        origin = Path(self.store.read(row["id"])["target"])
        from world.store import WorldStore
        source = WorldStore(origin)
        try:
            event = source.recover()["events"][0]["event"]
        finally:
            source.close()
        from genesis.store import _check_draft
        import hashlib
        digest = hashlib.sha256(_check_draft(row["draft"]).encode("utf-8")).hexdigest()
        publication = self.store.begin_product_publication(
            row["id"], row["revision"], target, digest, event["id"])
        (self.root / (".wispiva-world-" + publication["operation_id"])).mkdir()
        with self.assertRaises(WorldCreationError) as error:
            create_world(self.store, row["id"], row["revision"], target)
        self.assertEqual(error.exception.code, "publication_stage_requires_reconciliation")
        self.assertFalse(target.exists())
        self.assertEqual(self.store.product_publication(row["id"], row["revision"])["state"], "UNKNOWN")

    def test_startup_contract_rejects_changed_origin_database(self):
        row = self.confirmed()
        target = self.root / "world"
        target.parent.mkdir(exist_ok=True)
        result = create_world(self.store, row["id"], row["revision"], target)
        origin = target / "private" / "origin.sqlite"
        import sqlite3
        db = sqlite3.connect(origin)
        try:
            db.execute("UPDATE events SET event_id=? WHERE version=1", ("tampered-origin",))
            db.commit()
        finally:
            db.close()
        with self.assertRaises(ProductContractError):
            validate_world_contract(target, expected_world_id=result["world_id"])


if __name__ == "__main__":
    unittest.main()
