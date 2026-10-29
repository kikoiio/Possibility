#!/usr/bin/env python3
"""Describe SOCIETY runs using only the standard library; never infer significance.

Usage: python3 -B analysis/summarize.py --input evidence --output results.json
"""

import argparse
from collections import Counter, defaultdict
from datetime import datetime
import gzip
from itertools import chain
import json
import math
from pathlib import Path
import re
import statistics


SOCIETY = re.compile(r"\bSOCIETY\s+(?P<head>\S+)(?:\s+(?P<body>.*))?$")
FIELD = re.compile(r'(?P<key>[A-Za-z_]\w*)=(?P<value>"(?:\\.|[^"\\])*"|[^\s]+)')
PEAK_RSS = re.compile(r"(?:峰值\s*RSS|peak\s+RSS)\s*[:：]\s*(\d+(?:\.\d+)?)\s*MiB", re.I)
TIMESTAMP = re.compile(r"^\s*(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:[.,]\d+)?)")
SOURCE_SUFFIXES = (".log", ".log.gz", ".events", ".events.gz")


METRIC_KINDS = {"resource", "resource-verify", "message", "stats", "round", "summary",
                "shutdown", "banner", "artifact", "check", "verify", "done", "fail"}


def parse_records(lines, source, compact=False, include_kinds=None):
    """Read lines incrementally; compact mode keeps one example per non-metric kind.

    Multiplicity preserves exact event counts. First/last timestamps preserve the
    observation span even when movement or meeting records are collapsed.
    """
    records = []
    compressed = {}
    for number, line in enumerate(lines, 1):
        raw = line.rstrip("\r\n")
        match = SOCIETY.search(raw)
        if not match:
            continue
        head = match["head"]
        kind = head[3:] if head.startswith("ev=") else "fail" if head.startswith("fail=") else head
        if include_kinds is not None and kind not in include_kinds:
            continue
        timestamp = TIMESTAMP.match(raw)
        try:
            timestamp = datetime.fromisoformat(timestamp[1].replace(",", ".")).isoformat() if timestamp else None
        except ValueError:
            timestamp = None
        collapse = compact and kind not in METRIC_KINDS and not kind.startswith("model-")
        if collapse and kind in compressed:
            record = compressed[kind]
            record["multiplicity"] += 1
            record["last_line"] = number
            if timestamp is not None:
                record["timestamp"] = min(record["timestamp"], timestamp) if record["timestamp"] else timestamp
                record["last_timestamp"] = max(record["last_timestamp"], timestamp) if record["last_timestamp"] else timestamp
            continue
        fields = {}
        for field in FIELD.finditer(match["body"] or ""):
            value = field["value"]
            if value.startswith('"'):
                try:
                    value = json.loads(value)
                except ValueError:
                    pass
            fields[field["key"]] = value
        if head.startswith("fail="):
            fields["fail"] = head[5:]
        record = {"source": source, "line": number, "kind": kind,
                  "fields": fields, "raw": raw, "timestamp": timestamp}
        if collapse:
            record.update(multiplicity=1, last_line=number, last_timestamp=timestamp, compacted=True)
            compressed[kind] = record
        records.append(record)
    return records


def number(value, integer=False):
    if value is None:
        return None
    try:
        if integer and not re.fullmatch(r"\d+", value):
            return None
        result = int(value) if integer else float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (ValueError, OverflowError):
        return None


def distribution(values):
    """Nearest-rank p50/p95; median is the ordinary midpoint for even samples."""
    values = sorted(value for value in values if value is not None)
    if not values:
        return dict(samples=0, min=None, max=None, median=None, p50=None, p95=None)
    return dict(samples=len(values), min=values[0], max=values[-1],
                median=statistics.median(values),
                p50=values[math.ceil(0.50 * len(values)) - 1],
                p95=values[math.ceil(0.95 * len(values)) - 1])


def request_key(record):
    fields = record["fields"]
    if "request" not in fields:
        return None
    return fields.get("agent"), fields["request"]


def model_audits(records):
    """Attempts include retries; final action/response audits duplicate the last attempt.

    Older logs without attempt records use action or failed-response audits instead.
    Keys include the run so equal request IDs in different runs remain independent.
    """
    attempts = [r for r in records if r["kind"] == "model-attempt"]
    covered = {(r["run_id"], request_key(r)) for r in attempts if request_key(r) is not None}
    selected = list(attempts)
    for record in records:
        fields = record["fields"]
        terminal = record["kind"] == "fail" and fields["fail"].startswith("model-")
        if record["kind"] != "model-action" and not terminal:
            continue
        key = request_key(record)
        if key is not None and (record["run_id"], key) in covered:
            continue
        selected.append(record)
    return selected


def metrics(records):
    records = list(records)
    counts = Counter()
    for record in records:
        counts[record["kind"]] += record.get("multiplicity", 1)
    attempts = [r for r in records if r["kind"] == "model-attempt"]
    actions = [r for r in records if r["kind"] == "model-action"]
    terminals = [r for r in records if r["kind"] == "fail"
                 and r["fields"]["fail"].startswith("model-")]
    audits = model_audits(records)
    errors = Counter()
    for record in audits:
        fields = record["fields"]
        if record["kind"] == "fail" or (record["kind"] == "model-attempt" and
                (fields.get("ok") == "false" or fields.get("error", "none") != "none")):
            errors[fields.get("error", fields.get("fail", "unknown"))] += 1
    # Only the final failed attempt can explain a duplicate terminal failure.
    last_attempts = {(r["run_id"], request_key(r)): r["fields"] for r in attempts}
    audited_ids = {id(r) for r in audits}
    for record in terminals:
        fields = record["fields"]
        last = last_attempts.get((record["run_id"], request_key(record)), {})
        duplicate = (last.get("ok") == "false" and last.get("error") == fields.get("error"))
        if id(record) not in audited_ids and not duplicate:
            errors[fields.get("error", fields["fail"])] += 1
    tokens = {}
    for name in ("input_tokens", "output_tokens"):
        known = [value for r in audits
                 if (value := number(r["fields"].get(name), integer=True)) is not None]
        tokens[name] = sum(known) if known else None
        tokens[name + "_samples"] = len(known)
    tokens["audit_records"] = len(audits)
    tokens["complete"] = bool(audits) and all(
        tokens[name + "_samples"] == len(audits) for name in ("input_tokens", "output_tokens"))
    tokens["total_tokens"] = (sum(tokens[name] or 0 for name in ("input_tokens", "output_tokens"))
                              if any(tokens[name] is not None for name in ("input_tokens", "output_tokens"))
                              else None)

    resources = {action: dict(success=0, failure=0, unknown=0) for action in ("gather", "build")}
    conservation = dict(success=0, failure=0, unknown=0, checks=[])
    for record in records:
        fields = record["fields"]
        if record["kind"] == "resource" and fields.get("action") in resources:
            outcome = {"true": "success", "false": "failure"}.get(fields.get("ok"), "unknown")
            resources[fields["action"]][outcome] += 1
        elif record["kind"] == "resource-verify":
            check = {key: number(fields.get(key), integer=True) for key in ("initial", "world", "inventory")}
            check["reported_ok"] = {"true": True, "false": False}.get(fields.get("ok"))
            delta = (check["world"] + check["inventory"] - check["initial"]
                     if all(check[key] is not None for key in ("initial", "world", "inventory")) else None)
            check["delta"] = delta
            check["conserved"] = delta == 0 if delta is not None else None
            outcome = ("failure" if check["reported_ok"] is False or check["conserved"] is False
                       else "success" if check["conserved"] is True else "unknown")
            conservation[outcome] += 1
            check.update(run_id=record["run_id"], source=record["source"], line=record["line"])
            conservation["checks"].append(check)
    return {
        "event_counts": dict(sorted(counts.items())),
        "model": {
            "requests": counts["model-request"], "actions": len(actions),
            "actions_by_kind": dict(sorted(Counter(r["fields"].get("kind", "unknown") for r in actions).items())),
            "actions_by_origin": dict(sorted(Counter(r.get("origin", "unknown") for r in actions).items())),
            "attempts": len(attempts),
            "attempt_failures": sum(r["fields"].get("ok") == "false" for r in attempts),
            "terminal_failures": len(terminals), "stale_actions": counts["model-stale"],
            "errors": sum(errors.values()), "errors_by_code": dict(sorted(errors.items())),
            "latency_ms": distribution(number(r["fields"].get("latency_ms")) for r in audits),
            "action_latency_ms": distribution(number(r["fields"].get("latency_ms")) for r in actions),
            "tokens": tokens,
        },
        "resources": resources, "resource_conservation": conservation,
        "meets": counts["meet"], "messages": counts["message"],
        "failures_by_code": dict(sorted(Counter(r["fields"]["fail"] for r in records if r["kind"] == "fail").items())),
        "stats": {"records": counts["stats"], "steps_per_sec": distribution(
            number(r["fields"].get("steps_per_sec")) for r in records if r["kind"] == "stats")},
    }


def read_report(path):
    # Reports may contain another full copy of a multi-million-line log. The
    # header is sufficient for metadata; event supplements are streamed separately.
    text = None
    if path.is_file():
        header_lines = []
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                if re.match(r"^\s*--- SOCIETY", line):
                    break
                header_lines.append(line)
        text = "".join(header_lines)
    metadata = {"peak_rss_mib": None, "result": None, "execution_mode": "unknown", "config": {}}
    if text is not None:
        header = text.split("--- SOCIETY", 1)[0]
        match = PEAK_RSS.search(header)
        if match:
            metadata["peak_rss_mib"] = float(match[1])
        result = re.search(r"^\s*结果:\s*(PASS|FAIL)\s*$", header, re.M)
        if result:
            metadata["result"] = result[1]
        mode = re.search(r"^执行模式:\s*(.+)$", header, re.M)
        if mode:
            metadata["execution_mode"] = mode[1].strip()
        metadata["config"] = dict(re.findall(r"^\s+(\w+)\s*=\s*(.*?)\s*$", header, re.M))
    return metadata, text


def source_timing(records):
    stamps = [stamp for r in records for stamp in (r["timestamp"], r.get("last_timestamp")) if stamp is not None]
    first, last = (min(stamps), max(stamps)) if stamps else (None, None)
    span = (datetime.fromisoformat(last) - datetime.fromisoformat(first)).total_seconds() if stamps else None
    actions = sum(r["kind"] == "model-action" for r in records)
    return {"first_timestamp": first, "last_timestamp": last, "source_span_seconds": span,
            "model_actions_per_second": actions / span if span is not None and span > 0 else None}


def summarize(input_dir, compact=False):
    root = Path(input_dir)
    if not root.is_dir():
        raise ValueError(f"input must be a directory: {root}")
    candidates = defaultdict(dict)
    for path in root.rglob("*"):
        if path.is_file():
            for suffix in SOURCE_SUFFIXES:
                if path.name.endswith(suffix):
                    candidates[path.with_name(path.name[:-len(suffix)])][suffix] = path
                    break
    runs = []
    for stem, choices in sorted(candidates.items()):
        suffix = next(suffix for suffix in SOURCE_SUFFIXES if suffix in choices)
        source = choices[suffix]
        source_name = source.relative_to(root).as_posix()
        opener = gzip.open if suffix.endswith(".gz") else open
        with opener(source, "rt", encoding="utf-8") as stream:
            records = parse_records(stream, source_name, compact=compact)
        if not records:
            continue  # Worker/engine logs without SOCIETY events are not agent runs.
        report_path = stem.with_name(stem.name + ".report.txt")
        report_name = report_path.relative_to(root).as_posix()
        metadata, report_raw = read_report(report_path)
        if suffix.startswith(".events") and report_raw is not None:
            # run.sh deliberately strips these types from its deterministic .events.
            present = {r["kind"] for r in records}
            seen = set()
            missing = {"stats", "resource-verify"} - present
            if missing:
                with report_path.open(encoding="utf-8") as stream:
                    for record in parse_records(stream, report_name, include_kinds=missing):
                        signature = record["raw"][record["raw"].index("SOCIETY"):]
                        if signature not in seen:
                            records.append(record)
                            seen.add(signature)
        run_id = stem.relative_to(root).as_posix()
        for record in records:
            record["run_id"] = run_id
            if record["kind"] == "model-action":
                mode = metadata["execution_mode"]
                fallback = ("fixture" if mode.startswith("deterministic-fixture")
                            else "model" if mode == "real-model" else "unknown")
                record["origin"] = record["fields"].get("origin", fallback)
        summary = metrics(records)
        summary["throughput"] = source_timing(records)
        runs.append({
            "run_id": run_id, "source": source_name,
            "ignored_sources": [p.relative_to(root).as_posix() for p in choices.values() if p != source],
            "report_source": report_name if report_raw is not None else None,
            "report": metadata, "report_raw": report_raw,
            "summary": summary, "raw_records": records,
        })
    totals = metrics(chain.from_iterable(run["raw_records"] for run in runs))
    totals["runtime_peak_rss_mib"] = distribution(run["report"]["peak_rss_mib"] for run in runs)
    timed = [run for run in runs if run["summary"]["throughput"]["model_actions_per_second"] is not None]
    seconds = sum(run["summary"]["throughput"]["source_span_seconds"] for run in timed)
    actions = sum(run["summary"]["model"]["actions"] for run in timed)
    totals["throughput"] = {"measured_runs": len(timed), "measured_actions": actions,
                            "source_span_seconds": seconds if timed else None,
                            "model_actions_per_second": actions / seconds if seconds > 0 else None}
    return {
        "schema_version": 1, "input": str(root), "run_count": len(runs), "compact": compact,
        "notes": [
            "Descriptive observations only; no claims of statistical significance or causal effects.",
            "Canonical siblings are one run; precedence: .log, .log.gz, .events, .events.gz. Report events are not recounted.",
            "For .events only, absent stats/resource-verify types are recovered from the sibling report.",
            "Report raw text contains only the header; archived logs remain the full raw evidence.",
            "Compact mode retains metric records and one example per other event kind with exact multiplicity; memory scales with metric records, not movement/meeting volume.",
            "Latency p50/p95 use nearest rank. Totals pool observed samples across runs; they are not averages of run percentiles.",
            "Tokens/latency use all attempts, including retries; action/terminal audits are fallbacks only when that request has no attempts.",
            "Errors count failed attempts plus unrepresented terminal failures; terminal_failures separately counts final failures.",
            "Token sums cover known values only; null means no measurement and complete=false flags missing usage.",
            "Gather/build count resource outcomes; messages count delivery records, excluding message-text duplicates.",
            "RSS is the sampled runtime peak reported by run.sh, in MiB; it excludes the model worker/provider.",
            "Action origin uses origin=, then explicit report execution mode, otherwise unknown; fixture actions remain labeled.",
            "Throughput uses the observed SOCIETY timestamp span, not model service time. Pooled rates sum measured run spans, excluding untimed runs.",
        ],
        "totals": totals, "runs": runs,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="recursively search this directory")
    parser.add_argument("--output", required=True, type=Path, help="write descriptive JSON here")
    parser.add_argument("--compact", action="store_true", help="collapse repeated non-metric events using exact multiplicity")
    args = parser.parse_args(argv)
    try:
        result = summarize(args.input, compact=args.compact)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w", encoding="utf-8") as output:
            json.dump(result, output, ensure_ascii=False, indent=2, allow_nan=False)
            output.write("\n")
    except (OSError, ValueError) as error:
        parser.exit(2, f"summarize: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
