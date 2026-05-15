# Bash completion for Rivet
_rivet() {
  local cur prev words cword
  _init_completion || return

  local subcommands="config"
  local config_commands="show providers set-key set-key-env set-default add-model remove-model"

  case ${prev} in
    rivet)
      COMPREPLY=($(compgen -W "$subcommands --help --version -h -v" -- "$cur"))
      ;;
    config)
      COMPREPLY=($(compgen -W "$config_commands" -- "$cur"))
      ;;
    set-key|set-key-env|set-default|add-model|remove-model)
      # Provider name completion — read from config if available
      local config_file="$HOME/.rivet/config.json"
      if [[ -f "$config_file" ]]; then
        local providers=$(node -e "
          try { const c = JSON.parse(require('fs').readFileSync('$config_file','utf-8'));
            console.log(Object.keys(c.provider?.providers || {}).join(' ')); } catch {}
        " 2>/dev/null)
        COMPREPLY=($(compgen -W "$providers" -- "$cur"))
      fi
      ;;
    *)
      ;;
  esac
}
complete -F _rivet rivet
