#!/usr/bin/env bash
# PreToolUse-Hook: verhindert, dass Claude .env und .env.* liest.
# Erlaubt bleiben Vorlagen ohne Secrets: .env.example, .env.sample, .env.template.
# Exit 2 = Tool-Aufruf blockieren, stderr geht als Begründung an Claude.

input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input")

deny() {
  echo "Blockiert: $1 – Env-Dateien enthalten Secrets und dürfen nicht gelesen werden. Frag den Nutzer nach dem benötigten Wert." >&2
  exit 2
}

# Dateiname .env oder .env.<irgendwas>, außer Vorlagen
is_env_file() {
  local base
  base=$(basename -- "$1")
  [[ $base =~ ^\.env(\..+)?$ ]] || return 1
  [[ $base =~ ^\.env\.(example|sample|template)$ ]] && return 1
  return 0
}

case "$tool" in
  Read|Edit|Write|NotebookEdit)
    path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' <<<"$input")
    [[ -n $path ]] && is_env_file "$path" && deny "$path"
    ;;
  Grep)
    # Glob listet nur Dateinamen, Grep liest Inhalte
    path=$(jq -r '.tool_input.path // ""' <<<"$input")
    glob=$(jq -r '.tool_input.glob // ""' <<<"$input")
    [[ -n $path ]] && is_env_file "$path" && deny "$path"
    [[ $glob == *".env"* && ! $glob =~ \.env\.(example|sample|template)$ ]] && deny "Glob $glob"
    ;;
  Bash)
    cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
    # .env als eigenes Pfad-Token (nicht process.env.X, nicht file:.env.dev in Configs), Vorlagen ausgenommen
    hits=$(grep -oE '(^|[[:space:]/"'"'"'=<])\.env(\.[A-Za-z0-9_*-]+)?([[:space:]"'"'"';|&)>]|$)' <<<"$cmd" \
      | grep -vE '\.env\.(example|sample|template)([^A-Za-z0-9_-]|$)')
    [[ -n $hits ]] && deny "$(head -1 <<<"$hits" | tr -d " \"'=<;|&)>/") im Bash-Befehl"
    ;;
esac
exit 0
