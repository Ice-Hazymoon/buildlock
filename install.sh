#!/usr/bin/env bash
# buildlock installer.
#
#   curl -fsSL https://github.com/Ice-Hazymoon/buildlock/releases/latest/download/install.sh | bash
#
# Options (after `bash -s --` when piped):
#   --prefix DIR       install into DIR (default ~/.local/bin, or $BUILDLOCK_PREFIX)
#   --version vX.Y.Z   a specific release (default: the latest; "main" for the development version)
#   --from FILE        install a local copy of bin/buildlock instead of downloading
#   -y, --yes          no questions; skip setup
#   --no-setup         don't offer the guided setup
#   --force            replace a symlink or a file that is not buildlock
#
# Everything runs inside main, called on the last line: a download cut short
# runs nothing at all.
set -euo pipefail

main() {
    local repo=Ice-Hazymoon/buildlock prefix="${BUILDLOCK_PREFIX:-$HOME/.local/bin}" version=latest from=''
    local assume_yes=0 offer_setup=1 force=0 missing=() cmd url sums expected actual new_version target old_version
    local on_path rc answer locale="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" config_file
    local bold dim red green yellow cyan reset s_ok='ok' s_warn='!'

    if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
        bold=$'\e[1m' dim=$'\e[2m' red=$'\e[31m' green=$'\e[32m' yellow=$'\e[33m' cyan=$'\e[36m' reset=$'\e[0m'
    else
        bold='' dim='' red='' green='' yellow='' cyan='' reset=''
    fi
    if [[ "$locale" == *[Uu][Tt][Ff]-8* || "$locale" == *[Uu][Tt][Ff]8* ]]; then s_ok='✓'; fi
    step() { printf '%s==>%s %s\n' "$cyan" "$reset" "$*"; }
    ok() { printf '  %s%s%s %s\n' "$green" "$s_ok" "$reset" "$*"; }
    warn() { printf '  %s%s%s %s\n' "$yellow" "$s_warn" "$reset" "$*"; }
    die() { printf '%serror:%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }

    while (( $# > 0 )); do
        case "$1" in
            --prefix) prefix="${2:?--prefix needs a directory}"; shift ;;
            --prefix=*) prefix="${1#*=}" ;;
            --version) version="${2:?--version needs a tag}"; shift ;;
            --version=*) version="${1#*=}" ;;
            --from) from="${2:?--from needs a file}"; shift ;;
            --from=*) from="${1#*=}" ;;
            -y|--yes) assume_yes=1 ;;
            --no-setup) offer_setup=0 ;;
            --force) force=1 ;;
            -h|--help)
                printf 'Usage: install.sh [--prefix DIR] [--version vX.Y.Z|main] [--from FILE] [--yes] [--no-setup] [--force]\n'
                exit 0
                ;;
            *) die "unknown option: $1" ;;
        esac
        shift
    done
    # "--prefix=~/bin" reaches us unexpanded; a relative prefix would depend on where this ran.
    local t='~'
    [[ "$prefix" != "$t" && "$prefix" != "$t/"* ]] || prefix="$HOME${prefix#"$t"}"
    [[ "$prefix" == /* ]] || prefix="$PWD/$prefix"
    prefix="${prefix%/}"

    printf '%sbuildlock installer%s\n\n' "$bold" "$reset"

    step "Checking this machine"
    [[ "$(uname -s)" == Linux ]] || die "buildlock needs Linux (or WSL 2): it reads /proc and uses flock and setsid."
    (( BASH_VERSINFO[0] >= 5 )) || die "buildlock needs bash 5 or newer (this is $BASH_VERSION)."
    for cmd in flock setsid ps awk date nproc mktemp; do command -v "$cmd" > /dev/null || missing+=("$cmd"); done
    (( ${#missing[@]} == 0 )) || die "missing: ${missing[*]} (install util-linux, procps and coreutils)"
    setsid --help 2>&1 | grep -q -- --wait || die "setsid has no --wait; buildlock needs util-linux 2.31 or newer."
    ok "Linux, bash $BASH_VERSION, util-linux, procps"
    if [[ -r /proc/pressure/cpu ]]; then ok "pressure stall information available"; else warn "no /proc/pressure: buildlock will admit jobs on load and memory only"; fi

    # Checked before downloading, so a prefix that needs root fails with advice, not "Permission denied".
    target="$prefix/buildlock"
    local probe="$prefix"
    while [[ ! -d "$probe" ]]; do probe="$(dirname "$probe")"; done
    if [[ ! -w "$probe" ]]; then
        die "$prefix is not writable by $(id -un). Install for everyone with:
  curl -fsSL https://github.com/$repo/releases/latest/download/install.sh | sudo bash -s -- --prefix $prefix --yes
then run \"sudo buildlock update\" to update it, and \"buildlock setup\" as yourself."
    fi
    if [[ -L "$target" && "$force" == 0 ]]; then
        if [[ "$(readlink -f "$target")" == */node_modules/buildlock/* ]]; then
            die "$target comes from a package manager (npm install -g buildlock); update it with npm install -g buildlock@latest, or rerun with --force to replace the link"
        fi
        die "$target is a symlink to $(readlink -f "$target"); update that copy instead, or rerun with --force to replace the link"
    fi
    if [[ -f "$target" && ! -L "$target" && "$force" == 0 ]] && ! grep -q buildlock "$target" 2>/dev/null; then
        die "$target exists and is not buildlock; rerun with --force to replace it"
    fi

    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT

    fetch() {
        if command -v curl > /dev/null; then curl -fsSL --retry 2 -o "$2" "$1"
        elif command -v wget > /dev/null; then wget -q -O "$2" "$1"
        else die "needs curl or wget"
        fi
    }

    if [[ -n "$from" ]]; then
        step "Using $from"
        [[ -f "$from" ]] || die "no such file: $from"
        cp "$from" "$tmp/buildlock"
    else
        if [[ "$version" == main ]]; then
            url="https://raw.githubusercontent.com/$repo/main/bin/buildlock"
            sums=''
        elif [[ "$version" == latest ]]; then
            url="https://github.com/$repo/releases/latest/download/buildlock"
            sums="$url.sha256"
        else
            url="https://github.com/$repo/releases/download/$version/buildlock"
            sums="$url.sha256"
        fi
        step "Downloading buildlock ($version)"
        fetch "$url" "$tmp/buildlock" || die "download failed: $url"
        if [[ -n "$sums" ]]; then
            fetch "$sums" "$tmp/buildlock.sha256" || die "checksum download failed: $sums"
            expected="$(cut -d' ' -f1 < "$tmp/buildlock.sha256")"
            actual="$(sha256sum "$tmp/buildlock" | cut -d' ' -f1)"
            [[ "$expected" == "$actual" ]] || die "checksum mismatch (expected $expected, got $actual)"
            ok "checksum verified"
        fi
    fi
    bash -n "$tmp/buildlock" || die "the downloaded file is not a valid bash script"
    new_version="$(sed -n 's/^bl_version=//p' "$tmp/buildlock" | head -n1)"
    [[ -n "$new_version" ]] || die "the downloaded file is not buildlock"

    step "Installing to $prefix"
    mkdir -p "$prefix"
    old_version=''
    # Read, never run: versions before 0.1.0 would queue `--version` as a job.
    if [[ -f "$target" ]]; then old_version="$(sed -n 's/^bl_version=//p' "$target" | head -n1)"; [[ -n "$old_version" ]] || old_version=unversioned; fi
    # Rename over the old file, so jobs that are running keep reading their copy.
    rm -f "$prefix/.buildlock.new.$$"
    install -m 755 "$tmp/buildlock" "$prefix/.buildlock.new.$$"
    mv -f "$prefix/.buildlock.new.$$" "$target"
    if [[ -z "$old_version" ]]; then ok "installed buildlock $new_version"
    elif [[ "$old_version" == "$new_version" ]]; then ok "buildlock $new_version reinstalled"
    else ok "updated buildlock $old_version -> $new_version"
    fi

    on_path=1
    case ":$PATH:" in *":$prefix:"*) ;; *) on_path=0 ;; esac
    if (( on_path == 0 )); then
        # shellcheck disable=SC2088 # shown to the user, not expanded
        case "${SHELL##*/}" in
            zsh) rc='~/.zshrc' ;;
            fish) rc='~/.config/fish/config.fish' ;;
            *) rc='~/.bashrc' ;;
        esac
        warn "$prefix is not on your PATH. Add this line to $rc and open a new terminal:"
        if [[ "${SHELL##*/}" == fish ]]; then printf '      fish_add_path %s\n' "$prefix"; else printf '      export PATH="%s:$PATH"\n' "$prefix"; fi
    fi

    # Offered on a first install only (an update keeps the existing config). Piped
    # into bash, stdin is this script, so the question goes to the terminal.
    config_file="${BUILDLOCK_CONFIG-${XDG_CONFIG_HOME:-$HOME/.config}/buildlock/config}"
    if (( assume_yes == 0 && offer_setup == 1 && EUID != 0 )) && [[ -n "$config_file" && ! -e "$config_file" ]] && { true < /dev/tty; } 2>/dev/null; then
        printf '\n'
        printf '%sRun the guided setup now?%s It sets limits for this machine and teaches\n' "$bold" "$reset"
        printf 'your coding agents to use buildlock. %s[Y/n]%s ' "$dim" "$reset"
        read -r answer < /dev/tty || answer=n
        if [[ "${answer:-y}" =~ ^[Yy] ]]; then
            printf '\n'
            "$target" setup < /dev/tty
            exit 0
        fi
    fi

    printf '\n%sNext%s\n' "$bold" "$reset"
    printf '  %sbuildlock setup%s           guided setup (limits, quiet hours, coding agents)\n' "$cyan" "$reset"
    printf '  %sbuildlock agents install%s  teach Claude Code, Codex, Gemini and others to use it\n' "$cyan" "$reset"
    printf '  %sbuildlock npm test%s        run any heavy command through the queue\n' "$cyan" "$reset"
    printf '  %sbuildlock status%s          see what is running\n' "$cyan" "$reset"
}

main "$@"
