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


if __name__ == '__main__':
    unittest.main()
