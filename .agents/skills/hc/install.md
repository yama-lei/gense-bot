# Install hc and templates

See [SKILL.md](SKILL.md) for agent collaboration and [remote.md](remote.md) for remote machines. Installation instructions are based on the [herdr-core README](https://github.com/herdrdev/herdr-core#install).

## Install hc if missing

Check `command -v hc` (PowerShell: `Get-Command hc`). If present, check `hc --version` and keep the existing installation. Otherwise follow the upstream installation instructions:

```sh
# Linux and macOS
curl -fsSL https://releases.herdr.dev/core/install.sh | sh
hc --version
```

```powershell
# Windows PowerShell
powershell -c "irm https://releases.herdr.dev/core/install.ps1 | iex"
hc --version
```

Reopen the shell or update PATH if the installer says to do so. Windows templates and quoted shell commands also require `sh` on PATH (for example, Git for Windows). Install and authenticate each agent CLI separately; templates do not install agents or configure status reporting.

## Install the bundled templates if missing

From the repository root, on Linux or macOS:

```sh
template_dir="${XDG_CONFIG_HOME:-$HOME/.config}/herdr-core/templates"
mkdir -p "$template_dir"
for template in .agents/skills/hc/templates/*.md; do
  [ -e "$template_dir/${template##*/}" ] || cp -n "$template" "$template_dir/"
done
hc templates
```

On Windows PowerShell, from the repository root:

```powershell
$configHome = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { $env:APPDATA }
$templateDir = Join-Path $configHome 'herdr-core/templates'
New-Item -ItemType Directory -Force $templateDir | Out-Null
Get-ChildItem .agents/skills/hc/templates/*.md | ForEach-Object {
  $destination = Join-Path $templateDir $_.Name
  if (-not (Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath $_.FullName -Destination $destination }
}
hc templates
```

Existing files are preserved; compare them with the bundled versions and update them deliberately if desired. Template names come from filenames. Verify each command, model availability and authentication before use. The Codex and Claude templates request broad permissions; use them only when the task's authorization permits it. The Pi template requires a configured `opencode-go` provider and access to its selected model; choose an available model if needed. Codex must use `--no-daemon` under hc.
