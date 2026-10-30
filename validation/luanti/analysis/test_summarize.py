import gzip
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from validation.luanti.analysis import summarize


HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"


class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if name.endswith(".gz"):
            with gzip.open(path, "wt", encoding="utf-8") as stream:
                stream.write(text)
        else:
            path.write_text(text, encoding="utf-8")
        return path

    def fixture(self, name):
        return (FIXTURES / name).read_text(encoding="utf-8")

    def retry_run(self):
        self.write("nested/retries.run1.log", self.fixture("retries.txt"))
        self.write("nested/retries.run1.report.txt", self.fixture("report.txt"))
        return summarize.summarize(self.root)

    def test_retries_and_terminal_failure_have_no_duplicate_usage(self):
        result = self.retry_run()
        model = result["totals"]["model"]
        self.assertEqual((model["requests"], model["actions"], model["attempts"]), (2, 1, 5))
        self.assertEqual((model["errors"], model["attempt_failures"], model["terminal_failures"]), (4, 4, 1))
        self.assertEqual(model["errors_by_code"], {"invalid_action": 4})
        self.assertEqual(model["tokens"]["input_tokens"], 53)
        self.assertEqual(model["tokens"]["output_tokens"], 11)
        self.assertEqual(model["tokens"]["total_tokens"], 64)
        self.assertTrue(model["tokens"]["complete"])
        self.assertEqual(model["latency_ms"], dict(samples=5, min=50, max=300, median=90, p50=90, p95=300))
        self.assertEqual(model["action_latency_ms"]["samples"], 1)

    def test_resources_messages_stats_rss_and_raw_records(self):
        result = self.retry_run()
        run = result["runs"][0]
        totals = result["totals"]
        for action in ("gather", "build"):
            self.assertEqual(totals["resources"][action], dict(success=1, failure=1, unknown=0))
        self.assertEqual((totals["meets"], totals["messages"]), (1, 1))
        self.assertEqual(totals["stats"]["steps_per_sec"]["median"], 11)
        self.assertEqual((totals["stats"]["steps_per_sec"]["min"], totals["stats"]["steps_per_sec"]["max"]), (10, 12))
        self.assertEqual(totals["resource_conservation"]["success"], 1)
        self.assertEqual(totals["resource_conservation"]["checks"][0]["delta"], 0)
        self.assertEqual(run["report"]["peak_rss_mib"], 46)
        self.assertEqual(run["report"]["result"], "FAIL")
        self.assertEqual(run["report"]["config"]["society_count"], "1")
        self.assertEqual(run["report_raw"], self.fixture("report.txt").split("--- SOCIETY", 1)[0])
        self.assertEqual(run["raw_records"][0]["line"], 2)
        self.assertIn('engine="Luanti 5.10.0"', run["raw_records"][0]["raw"])
        self.assertEqual(run["raw_records"][0]["fields"]["engine"], "Luanti 5.10.0")
        text = next(r for r in run["raw_records"] if r["kind"] == "message-text")
        self.assertEqual(text["fields"]["text"], "hello latency_ms=999 input_tokens=999")
        self.assertNotIn("input_tokens", text["fields"])
        self.assertEqual(run["summary"]["throughput"]["source_span_seconds"], 10)
        self.assertEqual(run["summary"]["throughput"]["model_actions_per_second"], 0.1)

    def test_public_summary_removes_raw_messages_and_free_text_configuration(self):
        self.write("nested/retries.run1.log", self.fixture("retries.txt"))
        self.write("nested/retries.run1.report.txt", self.fixture("report.txt"))
        result = summarize.summarize(self.root, compact=True, public=True)
        encoded = json.dumps(result, ensure_ascii=False)
        run = result["runs"][0]
        self.assertNotIn("raw_records", run)
        self.assertNotIn("report_raw", run)
        self.assertNotIn("config", run["report"])
        self.assertNotIn("hello latency_ms=999", encoded)
        self.assertEqual(result["totals"]["messages"], 1)
        self.assertEqual(result["totals"]["event_counts"]["message-text"], 1)

    def test_missing_metadata_unknown_usage_and_invalid_samples(self):
        self.write("old.events", self.fixture("missing.txt"))
        result = summarize.summarize(self.root)
        run = result["runs"][0]
        self.assertIsNone(run["report_source"])
        self.assertIsNone(run["report"]["peak_rss_mib"])
        self.assertEqual(run["report"]["execution_mode"], "unknown")
        model = run["summary"]["model"]
        self.assertEqual(model["actions_by_origin"], {"unknown": 1})
        self.assertIsNone(model["tokens"]["total_tokens"])
        self.assertFalse(model["tokens"]["complete"])
        self.assertIsNone(model["latency_ms"]["p95"])
        self.assertIsNone(run["summary"]["stats"]["steps_per_sec"]["median"])
        self.assertEqual(run["summary"]["resources"]["build"]["unknown"], 1)
        self.assertEqual(run["summary"]["resource_conservation"]["failure"], 1)
        self.assertIsNone(run["summary"]["throughput"]["model_actions_per_second"])
        json.dumps(result, allow_nan=False)

    def test_canonical_precedence_for_all_compressed_siblings(self):
        for suffix in summarize.SOURCE_SUFFIXES:
            self.write("a.run1" + suffix, "SOCIETY ev=model-action kind=" + suffix + "\n")
        for expected in summarize.SOURCE_SUFFIXES:
            with self.subTest(expected=expected):
                result = summarize.summarize(self.root)
                self.assertEqual(result["run_count"], 1)
                self.assertEqual(result["totals"]["model"]["actions"], 1)
                self.assertEqual(result["runs"][0]["source"], "a.run1" + expected)
                self.assertEqual(result["runs"][0]["run_id"], "a.run1")
                (self.root / ("a.run1" + expected)).unlink()

    def test_gzip_log_with_report_header_only_and_provenance(self):
        self.write("ci/model.run1.log.gz", self.fixture("retries.txt"))
        header = self.fixture("report.txt").split("--- SOCIETY", 1)[0]
        self.write("ci/model.run1.report.txt", header)
        result = summarize.summarize(self.root)
        run = result["runs"][0]
        self.assertEqual(run["report"]["execution_mode"], "real-model")
        self.assertEqual(result["totals"]["model"]["actions_by_origin"], {"model": 1})
        self.assertEqual(result["totals"]["model"]["tokens"]["total_tokens"], 64)
        self.assertEqual(result["totals"]["runtime_peak_rss_mib"]["max"], 46)

    def test_events_report_supplements_are_deduplicated(self):
        records = self.fixture("retries.txt").splitlines()
        events = "\n".join(line[line.index("SOCIETY"):] for line in records if "SOCIETY" in line
                           and "SOCIETY stats" not in line and "SOCIETY resource-verify" not in line)
        self.write("run.events.gz", events)
        report = self.fixture("report.txt")
        self.write("run.report.txt", report + report)
        result = summarize.summarize(self.root)
        self.assertEqual(result["totals"]["model"]["attempts"], 5)
        self.assertEqual(result["totals"]["model"]["actions"], 1)
        self.assertEqual(result["totals"]["stats"]["records"], 3)
        self.assertEqual(result["totals"]["resource_conservation"]["success"], 1)
        recovered = [r for r in result["runs"][0]["raw_records"] if r["kind"] == "stats"]
        self.assertTrue(all(r["source"] == "run.report.txt" for r in recovered))
        self.assertEqual(result, summarize.summarize(self.root))

    def test_report_supplement_does_not_repeat_existing_event_types(self):
        self.write("run.events", "SOCIETY stats t=5 steps_per_sec=8\nSOCIETY resource-verify initial=2 world=1 inventory=1 ok=true\n")
        self.write("run.report.txt", self.fixture("report.txt"))
        totals = summarize.summarize(self.root)["totals"]
        self.assertEqual(totals["stats"]["records"], 1)
        self.assertEqual(totals["stats"]["steps_per_sec"]["median"], 8)
        self.assertEqual(len(totals["resource_conservation"]["checks"]), 1)

    def test_fallbacks_are_per_request_and_per_run(self):
        self.write("one/run.log", "SOCIETY ev=model-attempt agent=0 request=1 attempt=1 ok=true latency_ms=10 input_tokens=10 output_tokens=1\nSOCIETY ev=model-action agent=0 request=1 kind=inspect latency_ms=10 input_tokens=10 output_tokens=1\nSOCIETY ev=model-action agent=0 request=2 kind=inspect latency_ms=20 input_tokens=20 output_tokens=2\n")
        self.write("two/run.events", "SOCIETY ev=model-action agent=0 request=1 kind=inspect latency_ms=30 input_tokens=30 output_tokens=3\nSOCIETY fail=model-response agent=0 request=2 error=transport_error latency_ms=40 input_tokens=40 output_tokens=4\n")
        result = summarize.summarize(self.root)
        self.assertEqual(result["run_count"], 2)
        self.assertEqual(result["totals"]["model"]["tokens"]["total_tokens"], 110)
        self.assertEqual(result["totals"]["model"]["latency_ms"]["samples"], 4)
        self.assertEqual(result["totals"]["model"]["errors_by_code"], {"transport_error": 1})

    def test_partial_tokens_provenance_and_zero_latency(self):
        self.write("fixture.log.gz", "SOCIETY ev=model-action agent=0 request=1 kind=inspect latency_ms=0 input_tokens=0 output_tokens=unknown\nSOCIETY ev=model-action agent=0 request=2 kind=inspect origin=model latency_ms=0 input_tokens=0 output_tokens=0\n")
        self.write("fixture.report.txt", "执行模式: deterministic-fixture (not a model)\n峰值 RSS: 0 MiB\n")
        totals = summarize.summarize(self.root)["totals"]
        self.assertEqual(totals["model"]["actions_by_origin"], {"fixture": 1, "model": 1})
        self.assertEqual(totals["model"]["latency_ms"]["p95"], 0)
        self.assertEqual(totals["model"]["tokens"]["total_tokens"], 0)
        self.assertFalse(totals["model"]["tokens"]["complete"])
        self.assertEqual(totals["runtime_peak_rss_mib"]["max"], 0)
        self.assertIsNone(totals["throughput"]["model_actions_per_second"])

    def test_terminal_error_after_a_successful_retry_remains_visible(self):
        self.write("run.log", "SOCIETY ev=model-attempt agent=0 request=1 attempt=1 ok=false error=invalid_action input_tokens=1 output_tokens=1\nSOCIETY ev=model-attempt agent=0 request=1 attempt=2 ok=true error=none input_tokens=2 output_tokens=2\nSOCIETY fail=model-response agent=0 request=1 error=invalid_response input_tokens=2 output_tokens=2\n")
        model = summarize.summarize(self.root)["totals"]["model"]
        self.assertEqual(model["errors_by_code"], {"invalid_action": 1, "invalid_response": 1})
        self.assertEqual(model["tokens"]["total_tokens"], 6)

    def test_conservation_missing_and_disagreeing_metadata(self):
        self.write("run.events", "SOCIETY resource-verify initial=4 world=4 inventory=0 ok=false\nSOCIETY resource-verify initial=4 world=unknown inventory=0 ok=true\n")
        totals = summarize.summarize(self.root)["totals"]
        self.assertEqual(totals["resource_conservation"]["failure"], 1)
        self.assertEqual(totals["resource_conservation"]["unknown"], 1)

    def test_environment_regeneration_is_included_in_resource_conservation(self):
        self.write("run.events", "SOCIETY resource-verify initial=3 environment_delta=14 expected=17 world=16 inventory=1 ok=true\n")
        totals = summarize.summarize(self.root)["totals"]
        check = totals["resource_conservation"]["checks"][0]
        self.assertEqual(check["environment_delta"], 14)
        self.assertEqual(check["expected"], 17)
        self.assertEqual(check["delta"], 14)
        self.assertEqual(check["expected_delta"], 0)
        self.assertTrue(check["conserved"])

    def test_cli_repeated_runs_ignore_report_only_and_unrelated_logs(self):
        self.retry_run()
        self.write("worker.log", "not an agent run\n")
        self.write("orphan.report.txt", self.fixture("report.txt"))
        output = self.root / "output.json"
        for _ in range(2):
            process = subprocess.run([sys.executable, "-B", str(HERE / "summarize.py"),
                                      "--input", str(self.root), "--output", str(output)],
                                     capture_output=True, text=True, timeout=10)
            self.assertEqual(process.returncode, 0, process.stderr)
            result = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result["run_count"], 1)
            self.assertEqual(result["totals"]["model"]["actions"], 1)

    def test_empty_and_invalid_input(self):
        result = summarize.summarize(self.root)
        self.assertEqual(result["run_count"], 0)
        self.assertIsNone(result["totals"]["model"]["tokens"]["total_tokens"])
        with self.assertRaisesRegex(ValueError, "directory"):
            summarize.summarize(self.root / "missing")

    def test_compact_matches_full_metrics_without_retaining_repeated_events(self):
        repeated = "".join("2026-10-28 12:00:20: ACTION[Server]: SOCIETY ev=" + kind + " agent=0 with=1\n"
                           for _ in range(300) for kind in ("meet", "move", "inspect"))
        self.write("capacity.run1.log.gz", self.fixture("retries.txt") + repeated)
        self.write("capacity.run1.report.txt", self.fixture("report.txt"))
        full = summarize.summarize(self.root)
        compact = summarize.summarize(self.root, compact=True)
        self.assertEqual(compact["totals"], full["totals"])
        self.assertEqual(compact["runs"][0]["summary"], full["runs"][0]["summary"])
        self.assertEqual(compact["totals"]["meets"], 301)
        self.assertEqual(compact["totals"]["event_counts"]["move"], 300)
        records = compact["runs"][0]["raw_records"]
        self.assertLess(len(records), 35)
        self.assertEqual(sum(r.get("multiplicity", 1) for r in records), len(full["runs"][0]["raw_records"]))
        meet = next(r for r in records if r["kind"] == "meet")
        self.assertEqual(meet["multiplicity"], 301)
        self.assertEqual(meet["last_timestamp"], "2026-10-28T12:00:20")
        self.assertNotIn("SOCIETY ev=", compact["runs"][0]["report_raw"])

    def test_compact_parser_consumes_iterator_and_retains_load_bearing_records(self):
        def lines():
            for _ in range(1000):
                yield "SOCIETY ev=move agent=0 to=1,1,1\n"
            yield "SOCIETY round rounds=1\n"
            yield "SOCIETY ev=model-request agent=0 request=1\n"
            yield "SOCIETY fail=model-timeout agent=0 request=1\n"
            yield "SOCIETY shutdown alive=1\n"
        records = summarize.parse_records(lines(), "stream.log.gz", compact=True)
        self.assertEqual(len(records), 5)
        self.assertEqual(records[0]["multiplicity"], 1000)
        self.assertEqual([r["kind"] for r in records[1:]], ["round", "model-request", "fail", "shutdown"])

    def test_report_header_stops_before_event_body(self):
        class HeaderStream:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def __iter__(self):
                yield "峰值 RSS: 12 MiB\n"
                yield "--- SOCIETY 事件（原文）---\n"
                raise AssertionError("report event body must not be read for metadata")
        path = self.write("run.report.txt", "")
        with mock.patch.object(Path, "open", return_value=HeaderStream()):
            metadata, raw = summarize.read_report(path)
        self.assertEqual(metadata["peak_rss_mib"], 12)
        self.assertEqual(raw, "峰值 RSS: 12 MiB\n")

    def test_compact_cli_and_events_report_fallback(self):
        self.write("run.events.gz", "SOCIETY ev=meet agent=0 with=1\n" * 25)
        report = self.fixture("report.txt")
        self.write("run.report.txt", report + report)
        output = self.root / "compact.json"
        process = subprocess.run([sys.executable, "-B", str(HERE / "summarize.py"), "--compact",
                                  "--input", str(self.root), "--output", str(output)],
                                 capture_output=True, text=True, timeout=10)
        self.assertEqual(process.returncode, 0, process.stderr)
        result = json.loads(output.read_text(encoding="utf-8"))
        self.assertTrue(result["compact"])
        self.assertEqual(result["totals"]["meets"], 25)
        self.assertEqual(result["totals"]["stats"]["records"], 3)
        self.assertEqual(result["totals"]["resource_conservation"]["success"], 1)
        self.assertEqual(len(result["runs"][0]["raw_records"]), 5)


if __name__ == "__main__":
    unittest.main()
