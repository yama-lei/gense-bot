# Project-local Pi extensions

Install the local runtime dependency once after cloning this project:

```bash
cd .pi
npm ci --ignore-scripts --legacy-peer-deps
cd ..
pi
```

Approve project trust when prompted. Pi loads the two source entrypoints in `.pi/settings.json`; no build or profile is required.

- `pi-github-pr` displays the current branch's PR status through authenticated `gh`.
- `pi-fleet` adds `/fleet` and tools for explicitly launching or connecting local Pi sessions. On Linux, launching splits requires tmux 3.2+ or Zellij 0.44+ and Pi running inside that multiplexer. Loading Fleet does not automatically launch another session.

## Vendored source

The two packages under `.pi/vendor/pi-extensions/packages/` are ordinary project files, not a nested Git repository or submodule. Include them in this project's commits. Only `node_modules` is ignored.

Source: https://github.com/narumiruna/pi-extensions

Upstream revision: `e77647dde285ed23f652adbc2219cc5472a49343`.

Each package retains its runtime source and MIT license. Unused packages, monorepo configuration, build scripts, tests, and upstream documentation have been removed. The package manifests are marked private, declare source entrypoints, and omit removed build tooling. Runtime source is unchanged.

Fleet's UI library remains an npm dependency in `.pi/package.json`, with its resolved version recorded in `.pi/package-lock.json`. Pi supplies the host packages, so peer dependencies are not installed separately.

Review and copy updates to the selected packages deliberately rather than cloning the whole upstream repository into this directory. Restart Pi or use `/reload` after changing extension code.

Extensions run with your user permissions and are not sandboxed. Personal Pi configuration and `pi-gpt-search` are unchanged. Fleet stores preferences changed through `/fleet` in Pi's user-level `pi-fleet.json`, not this project's settings.
