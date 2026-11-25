# Interactive Skyline

## Tests run locally

Nothing starts the tests on a push or a pull request. The `ci` workflow (`.github/workflows/ci.yml`) runs only when it is started by hand. Whoever opens or updates a pull request runs the suites on their own machine first. `tests/README.md` describes every command and project.

| Command | What it runs | Time on an Apple M4 |
|---|---|---|
| `pnpm test:unit` | the unit tests | under a minute |
| `pnpm test:py` | the data pipelines' tests (needs `uv`) | 1.5 minutes |
| `pnpm build` | the production build | seconds |
| `pnpm test:e2e:gpu` | the functional browser specs on this machine's GPU, the map's and the drive's | about 20 minutes |
| `pnpm test:e2e:drive` | the drive's browser specs alone, on the GPU | 4 to 5 minutes |
| `pnpm test:perf:drive` | the drive's own JavaScript per frame | under a minute |
| `pnpm test:e2e:drive:software` | the drive in software rendering, with its goldens | about 30 minutes |
| `pnpm test:e2e` | the map in software rendering: goldens, hooks, budgets | hours on a busy machine |

Start the browser commands from a normal shell. From a sandboxed shell on macOS the browser silently gets software rendering, and the GPU projects then fail at once.

## Every pull request attests what ran

A pull request's description has a section named "Tests run". It states, for the commit the pull request is at:

- the commit (short SHA), the date and the machine;
- each command that was run, its result as counts (passed, failed, skipped) and how long it took;
- each failure by test name, with what is known about it (for example, that it fails the same way on the base branch);
- each command above that was not run, and why.

Only what was actually run on that commit goes in. When commits are added afterwards, run again and update the section, or say which commit each number is from. A pull request never says "tests pass" without this section.
