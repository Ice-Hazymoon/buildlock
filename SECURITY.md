# Security

buildlock runs commands on your behalf, ships a `curl | bash` installer and
edits coding agents' instruction and permission files, so reports about any of
that are welcome.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting: **Security → Report a
vulnerability** on https://github.com/Ice-Hazymoon/buildlock. Don't open a
public issue for it. You'll get an answer within a week.

## What to check before you install

- Every release asset has a `.sha256` file, which the installer and
  `buildlock update` verify, and build provenance from GitHub Actions:
  `gh attestation verify buildlock --repo Ice-Hazymoon/buildlock`.
- The installer and the program are single, readable bash files.
- `buildlock agents install` never allows `Bash(buildlock:*)` in Claude Code:
  wrapped commands keep their permission prompt.
