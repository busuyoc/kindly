# Vision

## One-liner

A declarative, shareable config format for KOReader — like Nix for your e-reader.

## Why now

KOReader is powerful but the setup experience is broken:
- 40+ plugins installed by default, most unused, creating cognitive overhead
- Settings live in nested menus 4-5 levels deep
- SimpleUI alone has dozens of knobs
- People share setups on r/koreader as prose ("Scale 70%, Margin 80%, Items: Power, Bookmarks...") that you replicate manually, tapping through menus on an e-ink screen

## Core value props

1. **Reproducible** — factory reset, new device, friend's e-reader → one command, done.
2. **Shareable** — r/koreader "my setup" becomes a YAML file you apply in seconds.
3. **Diffable** — see what changed, revert, version-control your reading setup.
4. **Presets** — "minimal reader", "PDF-heavy academic", "SimpleUI mosaic" as curated starting points.
5. **Less overhead** — the tool knows which plugins are defaults to disable, which are worth enabling.

## Non-goals (v1)

- Not a KOReader replacement or fork
- Not a GUI for configuring during reading — desktop-side only
- Not attempting to patch or modify plugin code
- Not cloud-hosted — local CLI, optional gist-based sharing

## Target users

- Devs who own multiple e-readers or reflash often
- r/koreader power users who tune their setup
- New users overwhelmed by the default experience — `korea init minimal` gets them somewhere reasonable
- Authors of plugins like SimpleUI who can ship a `korea` preset alongside their release

## Inspirations

- Nix flakes / home-manager
- Chezmoi (dotfiles)
- Ansible playbooks
- Ninite (curated install bundles for Windows)
