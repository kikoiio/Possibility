import unittest
from queue_sim import simulate


class QueueTests(unittest.TestCase):
    def test_one_worker_sequential_work_and_drops(self):
        result = simulate(2, 1, 4, 1, 1, 5)
        self.assertEqual(result['completed'], 4)
        self.assertEqual(result['dropped'], 0)
        self.assertEqual(result['queue_wait_p95_s'], 1)
        result = simulate(2, 1, 1, 1, 1, 0)
        self.assertEqual((result['completed'], result['dropped']), (1, 1))

    def test_requests_are_pending_before_their_actual_deadlines(self):
        result = simulate(2, 1, 2, 10, 1, 3)
        self.assertEqual((result['completed'], result['dropped'], result['pending_at_end']),
                         (0, 0, 2))
        self.assertIsNone(result['queue_wait_p95_s'])

    def test_retry_waits_for_expiration_then_interval(self):
        # Agent 0 occupies the worker until t=10. Agent 1 expires at t=3,
        # retries at t=4, and expires again at t=7.
        for end, dropped, pending in ((3, 1, 1), (3.5, 1, 1), (4, 1, 1),
                                      (4.5, 1, 2), (6, 1, 2), (7, 2, 1)):
            with self.subTest(end=end):
                result = simulate(2, 1, end, 10, 1, 3)
                self.assertEqual((result['completed'], result['dropped'], result['pending_at_end']),
                                 (0, dropped, pending))

    def test_worker_can_start_a_request_exactly_at_its_deadline(self):
        result = simulate(3, 2, 2, 1, 10, 1)
        self.assertEqual((result['completed'], result['dropped'], result['pending_at_end']),
                         (3, 0, 0))
        self.assertEqual(result['queue_wait_p95_s'], 1)

    def test_completions_at_horizon_count_but_new_arrivals_do_not(self):
        result = simulate(1, 1, 2, 1, 1, 0)
        self.assertEqual((result['completed'], result['dropped'], result['pending_at_end']),
                         (1, 0, 0))
        self.assertEqual(result['throughput_per_s'], 0.5)
        result = simulate(1, 1, 1, 1, 1, 0)
        self.assertEqual(result['completed'], 1)

    def test_fifo_service_continues_after_expired_requests_are_removed(self):
        # Initial requests 1/2 expire at t=2 and retry at t=3. One starts
        # at t=4; the other expires at t=5, retries at t=6, and starts at
        # its t=8 deadline. Expired work must not occupy a future worker.
        result = simulate(3, 1, 9, 4, 1, 2)
        self.assertEqual((result['completed'], result['dropped'], result['pending_at_end']),
                         (2, 4, 2))
        self.assertEqual(result['queue_wait_p95_s'], 1)

    def test_multiple_workers_preserve_queued_and_running_work_at_end(self):
        result = simulate(4, 2, 6, 2, 1, 100)
        self.assertEqual((result['completed'], result['dropped'], result['pending_at_end']),
                         (6, 0, 2))
        self.assertEqual(result['throughput_per_s'], 1)
        self.assertEqual(result['queue_wait_p95_s'], 2)

    def test_invalid_and_nonfinite_parameters_are_rejected(self):
        parameters = [2, 1, 6, 1, 1, 3]
        for index, invalid in ((0, 0), (0, True), (1, 0), (1, 1.5),
                               (2, 0), (3, 0), (4, 0), (5, -1)):
            args = parameters.copy()
            args[index] = invalid
            with self.subTest(index=index, invalid=invalid), self.assertRaises(ValueError):
                simulate(*args)
        for index in range(2, 6):
            for invalid in (float('nan'), float('inf'), -float('inf')):
                args = parameters.copy()
                args[index] = invalid
                with self.subTest(index=index, invalid=invalid), self.assertRaises(ValueError):
                    simulate(*args)


if __name__ == '__main__':
    unittest.main()
