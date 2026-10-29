import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from genesis.genesis import public_view, validate
from genesis.store import DraftStore
from genesis.world_create import create_world


CASES = Path(__file__).resolve().parents[1] / "evidence" / "luanti" / "genesis" / "2026-10-29-product-intents"


def load_cases():
    return [json.loads(path.read_text(encoding="utf-8"))
            for path in sorted(CASES.glob("*/record.json"))]


class ProductIntentTests(unittest.TestCase):
    def test_two_non_fixture_intents_edit_confirm_and_preserve_private_boundary(self):
        cases = load_cases()
        self.assertEqual([case["case_id"] for case in cases],
                         ["canal-dye-house", "desert-observatory"])
        for case in cases:
            with self.subTest(case=case["case_id"]):
                self.assertEqual(validate(case["draft_v1"]), [])
                self.assertEqual(validate(case["draft_v2"]), [])
                self.assertNotEqual(case["draft_v1"], case["draft_v2"])
                public = public_view(case["draft_v2"])
                public_text = json.dumps(public, ensure_ascii=False)
                for secret in case["private_boundary"]["must_not_appear_in_public"]:
                    self.assertNotIn(secret, public_text)
                self.assertNotIn("goal", public["actors"][0])
                self.assertNotIn("memories", public)

                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    drafts = DraftStore(root / "drafts.sqlite", create=True)
                    try:
                        seen = []

                        def model(system, user_json):
                            seen.append(json.loads(user_json))
                            return json.dumps(case["draft_v1"], ensure_ascii=False)

                        row = drafts.create_from_intent(case["intent"], model)
                        self.assertEqual(seen, [{"intent": case["intent"]}])
                        self.assertEqual(row["intent"], case["intent"])
                        edited = drafts.update(row["id"], 1, copy.deepcopy(case["draft_v2"]))
                        self.assertEqual(edited["revision"], 2)
                        self.assertEqual(edited["intent"], case["intent"])

                        origin = root / "origin.sqlite"
                        confirmed = drafts.confirm(row["id"], 2, origin)
                        self.assertEqual(confirmed["status"], "confirmed")
                        self.assertEqual(drafts.read(row["id"])["status"], "confirmed")

                        product = root / "world"
                        created = create_world(drafts, row["id"], 2, product)
                        self.assertEqual(created["status"], "created")
                        manifest = json.loads(
                            (product / "private" / "wispiva-origin.json").read_text(encoding="utf-8"))
                        creation = json.loads(
                            (product / "private" / "creation.json").read_text(encoding="utf-8"))
                        self.assertEqual(manifest["intent"], case["intent"])
                        self.assertEqual(manifest["revision"], 2)
                        self.assertEqual(
                            manifest["intent_sha256"],
                            hashlib.sha256(case["intent"].encode("utf-8")).hexdigest())
                        self.assertEqual(creation["intent_sha256"], manifest["intent_sha256"])
                        self.assertEqual(
                            [actor["actor_id"] for actor in manifest["actors"]],
                            ["niko", "pavel", "sena"] if case["case_id"] == "canal-dye-house"
                            else ["omid", "tala", "ves"])
                        for actor in manifest["actors"]:
                            self.assertTrue(actor["role"])
                            self.assertTrue(actor["goal"])
                            self.assertTrue(actor["memory_seeds"])
                    finally:
                        drafts.close()


if __name__ == "__main__":
    unittest.main()
