import json
import unittest

from model.adapter import Config
from model.reflection import ReflectionError, build_input, reflect, validate_output
from model.reflection_host import ReflectionHostError, reflect_and_persist


def _request():
    return build_input(
        world_id="world-1", actor_id="alice", topic="the well",
        experiences=[{
            "id": "l1-1", "text": "I saw Bob near the well.",
            "source": {"kind": "event", "id": "event-1"},
            "audience": ["alice"], "captured_at": 3,
        }])


class ReflectionTests(unittest.TestCase):
    def test_input_is_private_and_bounded(self):
        request = _request()
        self.assertEqual(request["request"]["actor_id"], "alice")
        self.assertEqual(request["experiences"][0]["audience"], ["alice"])
        with self.assertRaises(ReflectionError):
            build_input(world_id="world-1", actor_id="alice", topic="x", experiences=[])
        with self.assertRaises(ReflectionError):
            build_input(world_id="world-1", actor_id="alice", topic="x", experiences=[
                {"id": "x", "text": "secret", "source": {"kind": "event", "id": "e"},
                 "audience": ["bob"]}])

    def test_output_must_cite_supplied_experiences(self):
        request = _request()
        self.assertEqual(validate_output({"topic": "the well", "text": "Bob may help.",
                                          "source_ids": ["l1-1"]}, request)["source_ids"], ["l1-1"])
        for value in (
            {"topic": "other", "text": "x", "source_ids": ["l1-1"]},
            {"topic": "the well", "text": "x", "source_ids": ["missing"]},
            {"topic": "the well", "text": "x", "source_ids": ["l1-1", "l1-1"]},
        ):
            with self.assertRaises(ReflectionError):
                validate_output(value, request)

    def test_bridge_uses_only_reflection_input_and_returns_audit(self):
        request = _request()
        seen = []

        def transport(config, body):
            seen.append(json.loads(body))
            return (b'data: {"type":"response.output_text.delta","delta":"{\\"topic\\":\\"the well\\",\\"text\\":\\"Bob may help.\\",\\"source_ids\\":[\\"l1-1\\"]}"}\n\n'
                    b'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n')

        result = reflect(Config("https://example.test/v1", "test", "secret"), request,
                         transport=transport)
        self.assertEqual(result["reflection"]["source_ids"], ["l1-1"])
        self.assertEqual(seen[0]["input"][1]["content"], json.dumps(request, ensure_ascii=True,
                                                                       sort_keys=True, separators=(",", ":")))

    def test_host_persists_only_after_source_grounded_provider_result(self):
        request = _request()
        persisted = []

        def append(*args):
            persisted.append(args)
            actor, topic, source_ids, text, time, source_id = args
            return {"id": "reflection:alice:the well:1", "layer": "L2", "owner": actor,
                    "topic": topic, "experiences": source_ids, "text": text,
                    "time": time, "source": {"kind": "reflection", "id": source_id}}

        def transport(config, body):
            return (b'data: {"type":"response.output_text.delta","delta":"{\\"topic\\":\\"the well\\",\\"text\\":\\"Bob may help.\\",\\"source_ids\\":[\\"l1-1\\"]}"}\n\n'
                    b'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n')

        result = reflect_and_persist(Config("https://example.test/v1", "test", "secret"),
                                     request, append, time=4, source_id="provider-1",
                                     transport=transport)
        self.assertEqual(result["persisted"]["id"], "reflection:alice:the well:1")
        self.assertEqual(persisted[0][:3], ("alice", "the well", ["l1-1"]))

    def test_host_rejects_bad_persistence_result(self):
        request = _request()

        def append(*args):
            return {"id": "wrong", "layer": "L1", "owner": "alice",
                    "topic": "the well", "experiences": ["l1-1"]}

        def transport(config, body):
            return (b'data: {"type":"response.output_text.delta","delta":"{\\"topic\\":\\"the well\\",\\"text\\":\\"x\\",\\"source_ids\\":[\\"l1-1\\"]}"}\n\n'
                    b'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n')

        with self.assertRaises(ReflectionHostError):
            reflect_and_persist(Config("https://example.test/v1", "test", "secret"),
                                request, append, time=4, transport=transport)


if __name__ == "__main__":
    unittest.main()
