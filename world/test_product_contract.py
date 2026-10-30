import json
import tempfile
import unittest
from pathlib import Path

from engine.luanti.world_identity import create_world_identity
from world.product_contract import (
    ProductContractError, build_contract, validate_contract, validate_world_contract,
)


class ProductContractTests(unittest.TestCase):
    def manifest(self):
        return {
            "world_id": "12345678-1234-4234-8234-123456789abc",
            "origin_event_id": "genesis:abc",
            "draft_id": "draft-1",
            "revision": 2,
            "draft_sha256": "a" * 64,
        }

    def test_contract_round_trip_and_identity_binding(self):
        manifest = self.manifest()
        contract = build_contract(manifest)
        self.assertEqual(validate_contract(contract), contract)
        with tempfile.TemporaryDirectory() as raw:
            world = Path(raw)
            create_world_identity(world)
            manifest["world_id"] = (world / "wispiva-world-id").read_text().strip()
            contract = build_contract(manifest)
            private = world / "private"
            private.mkdir(mode=0o700)
            for name, value in (
                ("wispiva-contract.json", contract),
                ("wispiva-origin.json", dict(manifest, contract=contract)),
                ("creation.json", {
                    "manifest": "private/wispiva-origin.json",
                    "contract": "private/wispiva-contract.json",
                    "world_id": contract["world_id"],
                    "origin_event_id": contract["origin_event_id"],
                }),
            ):
                path = private / name
                path.write_text(json.dumps(value), encoding="utf-8")
                path.chmod(0o600)
            self.assertEqual(validate_world_contract(world), contract)

    def test_tampered_manifest_is_rejected(self):
        manifest = self.manifest()
        contract = build_contract(manifest)
        with tempfile.TemporaryDirectory() as raw:
            world = Path(raw)
            create_world_identity(world)
            identity = (world / "wispiva-world-id").read_text().strip()
            private = world / "private"
            private.mkdir(mode=0o700)
            contract["world_id"] = identity
            (private / "wispiva-contract.json").write_text(json.dumps(contract), encoding="utf-8")
            (private / "wispiva-origin.json").write_text(json.dumps(dict(manifest, world_id=identity)), encoding="utf-8")
            (private / "creation.json").write_text(json.dumps({
                "manifest": "private/wispiva-origin.json",
                "contract": "private/wispiva-contract.json",
                "world_id": identity,
                "origin_event_id": contract["origin_event_id"],
            }), encoding="utf-8")
            for path in private.iterdir():
                path.chmod(0o600)
            with self.assertRaises(ProductContractError) as error:
                validate_world_contract(world)
            self.assertEqual(error.exception.args[0], "manifest_contract_mismatch")


if __name__ == "__main__":
    unittest.main()