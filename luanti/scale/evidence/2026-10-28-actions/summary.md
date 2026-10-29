# Luanti capacity ladder

Version: `Luanti 5.10.0 (Linux)`; threshold: 11.0 steps/s.

| Mode | Count | Repeat | Valid | Meets threshold | Median steps/s | Peak RSS KiB | Errors |
|---|---:|---:|---|---|---:|---:|---|
| idle | 100 | 1 | True | True | 11.08 | 47092 |  |
| idle | 1000 | 1 | True | False | 11.02 | 66512 |  |
| idle | 5000 | 1 | True | True | 11.06 | 95140 |  |
| idle | 10000 | 1 | True | True | 11.05 | 102868 |  |
| move | 100 | 1 | True | True | 11.05 | 50344 |  |
| move | 1000 | 1 | True | False | 11.02 | 70428 |  |
| move | 5000 | 1 | True | True | 11.03 | 101784 |  |
| move | 10000 | 1 | True | False | 11.03 | 113252 |  |
| perceive | 100 | 1 | True | False | 11.0 | 50328 |  |
| perceive | 1000 | 1 | True | True | 11.02 | 70012 |  |
| perceive | 5000 | 1 | True | False | 3.39 | 101956 |  |
| perceive | 10000 | 1 | True | False | 0.95 | 113236 |  |
