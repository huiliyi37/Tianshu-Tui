#compdef rivet

_rivet() {
  local -a commands config_commands
  commands=(
    'config:Manage API keys and model configuration'
    '--help:Show help'
    '--version:Show version'
    '-h:Show help'
    '-v:Show version'
  )

  config_commands=(
    'show:Show current configuration'
    'providers:List configured providers'
    'set-key:Set API key for a provider'
    'set-key-env:Set API key from environment variable'
    'set-default:Set default provider'
    'add-model:Add a model to a provider'
    'remove-model:Remove a model from a provider'
  )

  _arguments -C \
    '1:command:->command' \
    '*::arg:->args'

  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        config)
          _arguments \
            '1:config command:->config_cmd' \
            '*::config arg:->config_args'
          case $state in
            config_cmd)
              _describe 'config command' config_commands
              ;;
            config_args)
              # Provider completion from config file
              local config_file="$HOME/.rivet/config.json"
              if [[ -f "$config_file" ]]; then
                local -a providers
                providers=(${(f)"$(node -e "
                  try { const c = JSON.parse(require('fs').readFileSync('$config_file','utf-8'));
                    console.log(Object.keys(c.provider?.providers || {}).join('\n')); } catch {}
                " 2>/dev/null)"})
                _describe 'provider' providers
              fi
              ;;
          esac
          ;;
      esac
      ;;
  esac
}

_rivet "$@"
