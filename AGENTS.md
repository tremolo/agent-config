# Agent Notes

## Releases

1. Run `npm version <patch|minor|major>` and verify `package.json` updates.
2. Update `CHANGELOG.md` for the release.
3. Commit the release changes and tag with the same version.
4. Push commits and tags, then publish with `npm publish` if needed.

## Extensions

Pi extensions live in `./pi-extensions`. When working in this repo, add or update extensions there. You can consult the `pi-mono` for reference, but do not modify code in `pi-mono`.

When asking users for simple single-choice feedback, always use this workflow:
1. Prefer the `ask_pick` tool (direct interactive picker via `ctx.ui.select`).
2. If interactive tools are unavailable in the current runtime, fall back to plain-text numbered options in chat.
3. Use `/pick` only as a manual user command fallback (not as the primary agent-triggered path).

### Extension development workflow (avoid command clashes)

Use this lifecycle for new custom extensions:

1. **Prototype only in** `~/.pi/agent/extensions/<name>.ts`
2. Iterate locally with `/reload`
3. When stable, **move** (do not copy) the file to `./pi-extensions/<name>.ts`
4. Remove the prototype from `~/.pi/agent/extensions/` so only one source defines the command/tool
5. Commit + push in `agent-config`
6. After `pi update`, extension is loaded from checkout path (`~/.pi/agent/git/github.com/tremolo/agent-config/pi-extensions/...`)

Rule: **an extension command/tool must exist in only one active location at a time**. If duplicated across global and package paths, Pi will report conflicts and skip one.

### Interactive question workflow (always)

For single-question, single-choice user feedback:
- Use the `ask_pick` tool first.
- Keep options concise (2–5) and include "Something else / clarify" when appropriate.
- Mention a sensible default in assistant text before asking.
- Use suggestion-first phrasing (e.g., "I’d suggest …") before presenting options.
- If interactive mode/tooling is unavailable, ask in plain text with the same options.

Use `/answer` only when multi-question or free-text collection is needed.
Use `/pick` as a manual command fallback when direct `ask_pick` tool execution is not possible.
