import json
import tempfile
import unittest
from pathlib import Path

from genesis.store import DraftStore, DraftConflict
from genesis.test_genesis import draft
from genesis.world_create import WorldCreationError, create_world
from engine.luanti.world_identity import read_world_identity


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
        self.assertEqual(manifest["actors"][0]["memory_seeds"][0]["text"], "私人的经历")
        self.assertTrue((target / "worldmods" / "society" / "init.lua").is_file())
        self.assertTrue((target / "server.conf").is_file())
        self.assertTrue((target / "private" / "origin.sqlite").is_file())
        self.assertEqual((target / "private" / "wispiva-origin.json").stat().st_mode & 0o777, 0o600)

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


if __name__ == "__main__":
    unittest.main()
