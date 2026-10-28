#!/usr/bin/env python3
"""Simulate closed-loop agents using FIFO model workers; no model is called.

Each agent submits at time zero and waits for completion or actual queue
expiration before waiting ``interval`` seconds and submitting again. ``seconds``
is the observation horizon, not a drain period: arrivals at the horizon are
excluded, completions and expirations at the horizon are included, and requests
still queued or in service are pending. ``max_wait`` limits queue time only;
service may start exactly at that deadline and then takes ``latency`` seconds.
"""
import argparse
from collections import deque
import heapq
import json
import math


def simulate(agents, workers, seconds, latency, interval, max_wait):
    if (type(agents) is not int or type(workers) is not int or agents < 1 or workers < 1
            or any(type(value) not in (int, float) or not math.isfinite(value)
                   for value in (seconds, latency, interval, max_wait))
            or min(seconds, latency, interval) <= 0 or max_wait < 0):
        raise ValueError('invalid simulation parameters')
    # A completion frees capacity before arrivals and expirations at the same
    # time, so an already queued request can start exactly at its deadline.
    completion, arrival, expiration = 0, 1, 2
    events = [(0.0, arrival, agent) for agent in range(agents)]
    heapq.heapify(events)
    queued = deque()
    active = {}
    free_workers = workers
    next_request = 0
    completed = dropped = 0
    waits = []

    def start_waiting(now):
        nonlocal free_workers
        while free_workers and queued:
            request_id = queued.popleft()
            request = active.get(request_id)
            if request is None:  # An expired request must never reserve service.
                continue
            request['started'] = now
            free_workers -= 1
            heapq.heappush(events, (now + latency, completion, request_id))

    def next_arrival(now, agent):
        if now + interval < seconds:
            heapq.heappush(events, (now + interval, arrival, agent))

    while events:
        now, kind, identifier = heapq.heappop(events)
        if now > seconds:
            break
        if kind == arrival:
            if now >= seconds:
                continue
            request_id = next_request
            next_request += 1
            request = {'agent': identifier, 'arrived': now, 'started': None}
            active[request_id] = request
            queued.append(request_id)
            start_waiting(now)
            if request['started'] is None:
                heapq.heappush(events, (now + max_wait, expiration, request_id))
        elif kind == completion:
            request = active.pop(identifier)
            completed += 1
            waits.append(request['started'] - request['arrived'])
            free_workers += 1
            next_arrival(now, request['agent'])
            start_waiting(now)
        else:
            request = active.get(identifier)
            if request is None or request['started'] is not None:
                continue
            del active[identifier]
            dropped += 1
            next_arrival(now, request['agent'])
            while queued and queued[0] not in active:
                queued.popleft()
    waits.sort()
    return {'agents': agents, 'workers': workers, 'duration_s': seconds, 'service_latency_s': latency,
            'interval_after_completion_s': interval, 'max_queue_wait_s': max_wait,
            'completed': completed, 'dropped': dropped, 'pending_at_end': len(active),
            'throughput_per_s': completed / seconds,
            'queue_wait_p95_s': waits[math.ceil(len(waits) * .95) - 1] if waits else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--agents', type=int, required=True)
    parser.add_argument('--workers', type=int, required=True)
    parser.add_argument('--seconds', type=float, default=60, help='observation horizon; queued and running requests remain pending')
    parser.add_argument('--latency', type=float, required=True, help='service duration after a worker starts a request')
    parser.add_argument('--interval', type=float, default=2, help='delay after completion or expiration before the same agent submits again')
    parser.add_argument('--max-wait', type=float, default=30, help='queue deadline after arrival; starting exactly at the deadline is allowed')
    args = parser.parse_args()
    print(json.dumps(simulate(args.agents, args.workers, args.seconds, args.latency, args.interval, args.max_wait), sort_keys=True))


if __name__ == '__main__':
    main()
