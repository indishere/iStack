# iStack

Six agent skills adapted from [tstack](https://github.com/t3dotgg/tstack), with a native Node.js PR watcher and no Python dependency.

| Skill | Say | Purpose |
|---|---|---|
| full-send | full send | Implement, prove, review, file, babysit and merge a PR. |
| full-stop | full stop | Same workflow, but leave the PR unmerged. |
| council | council | Review with three models from different providers. |
| file-pr | file a PR | Open a concise problem-first PR. |
| babysit-pr | babysit | Monitor checks, reviews and actionable PR changes. |
| leaving-pr-comments | automatic | Format agent-authored GitHub comments. |

## Install

```sh
git clone https://github.com/indishere/iStack.git
mkdir -p ~/.claude/skills ~/.codex/skills
cp -R iStack/skills/* ~/.claude/skills/
cp -R iStack/skills/* ~/.codex/skills/
```

## Requirements

- Node.js 22+ and authenticated GitHub CLI (`gh`).
- No npm dependencies or Python runtime.
- Council requires three model providers and a harness that supports delegation.
- T3 Code uses its native PR watcher. Other harnesses use `node /absolute/path/to/scripts/pr-wait.cjs 123 --repo owner/name --until ready`.

Full Send uses Council, File PR and Babysit PR. Full Stop uses Full Send without merging. File PR and Babysit PR use Leaving PR Comments.

Run the tests with `node --test skills/babysit-pr/scripts/pr-wait.test.cjs`.

The watcher maintains persistent state in `~/.local/state/pr-wait/`. Exclusive lock files are cleaned up on normal exit and handled signals. After an abrupt termination, verify the recorded PID has stopped before manually removing a stale `.node.lock`. Do not run the legacy Python watcher for the same PR.

## Attribution and licenses

Based on [t3dotgg/tstack at 11e37a7](https://github.com/t3dotgg/tstack/tree/11e37a74d0a6868c121cd0910ab2b3bd9873b92a). Imported material and its adaptations retain the [upstream MIT license and copyright notice](LICENSE.tstack). The existing [iStack license](LICENSE) applies to original material not derived from tstack.
