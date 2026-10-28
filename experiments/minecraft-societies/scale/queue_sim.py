#!/usr/bin/env python3
"""Simulate serial/concurrent model workers; this does not call a model."""
import argparse
import heapq
import json
import math


def simulate(agents, workers, seconds, latency, interval, max_wait):
    if agents < 1 or workers < 1 or min(seconds, latency, interval) <= 0 or max_wait < 0:
        raise ValueError('invalid simulation parameters')
    arrivals = [(0.0, agent) for agent in range(agents)]
    heapq.heapify(arrivals)
    available = [(0.0, worker) for worker in range(workers)]
    heapq.heapify(available)
    completed = dropped = pending = 0
    waits = []
    while arrivals:
        at, agent = heapq.heappop(arrivals)
        if at >= seconds:
            break
        free, worker = heapq.heappop(available)
        start = max(at, free)
        wait = start - at
        if wait > max_wait:
            dropped += 1
            heapq.heappush(available, (free, worker))
            heapq.heappush(arrivals, (at + interval, agent))
            continue
        finish = start + latency
        heapq.heappush(available, (finish, worker))
        if finish > seconds:
            pending += 1
            continue
        completed += 1
        waits.append(wait)
        heapq.heappush(arrivals, (finish + interval, agent))
    waits.sort()
    return {'agents': agents, 'workers': workers, 'duration_s': seconds, 'service_latency_s': latency,
            'interval_after_completion_s': interval, 'max_queue_wait_s': max_wait,
            'completed': completed, 'dropped': dropped, 'pending_at_end': pending,
            'throughput_per_s': completed / seconds,
            'queue_wait_p95_s': waits[math.ceil(len(waits) * .95) - 1] if waits else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--agents', type=int, required=True)
    parser.add_argument('--workers', type=int, required=True)
    parser.add_argument('--seconds', type=float, default=60)
    parser.add_argument('--latency', type=float, required=True)
    parser.add_argument('--interval', type=float, default=2)
    parser.add_argument('--max-wait', type=float, default=30)
    args = parser.parse_args()
    print(json.dumps(simulate(args.agents, args.workers, args.seconds, args.latency, args.interval, args.max_wait), sort_keys=True))


if __name__ == '__main__':
    main()
