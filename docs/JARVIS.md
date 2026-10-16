# Jarvis ↔ Coucou integration

[Jarvis](https://github.com/sricharanenabothula704-star) is a local, voice-first assistant that runs
on this machine (Python, `C:\Users\PC\jarvis\v2`): wake word → local speech-to-text → a Claude brain
(Opus for the hard turns, Haiku for quick ones) → neural voice, with PC control, Gmail/Drive, web
search and a safety-approval gate. Coucou is its command centre on Windows.

Nothing in Coucou's own code depends on Jarvis; the integration is two small, additive seams.

## 1. Jarvis shows in the island

On every deep-brain turn, Jarvis reports to Coucou through the **same `coucou-hook` relay** the other
agents use, tagged `--agent jarvis`:

```
jarvis (python) ──spawn──▶ coucou-hook --agent jarvis  ──named pipe──▶ Coucou
                 stdin: {"hook_event_name":"UserPromptSubmit"|"PreToolUse"|"Stop", …}
```

- It appears as its own **Jarvis** agent pill (`agent_jarvis` in `src/core/pills.ts`) and is logged in
  the recap. `recap.rs` already accepts any lowercase ≤24-char `coucou_agent`, so no Rust change was
  needed for the pill itself.

## 2. Approve Jarvis from the island / iPhone

`"jarvis"` is in the hook's `takes_decisions` (`hook/src/reply.rs`). So when Jarvis wants to do
something risky, it sends a `PermissionRequest` through the hook; `pipe.rs` holds it for the island's
answer and relays your **Allow / Deny** back. Jarvis asks in three places at once — its voice, its own
HUD, and the island/iPhone — each showing the **whole command**; the first answer wins. If the island
is closed, Jarvis's local voice/HUD prompt still decides.

## 3. Jarvis as a chat brain

Jarvis runs an **OpenAI-compatible server** on `http://127.0.0.1:8765` (`/v1/models`,
`/v1/chat/completions`, streamed), backed by an answer-only Opus brain. It is registered as a chat
provider (`src/core/providers.ts`, id `jarvis`, no key, no URL field), so **Jarvis** appears in the
chat's model picker and routes there through `local_chat.rs` — always available while Jarvis is
running, nothing to set up. Override the address with the `JARVIS_URL` environment variable.

## Keeping it running

Jarvis starts with Windows. If it is not running, the Jarvis chat provider simply reports it cannot
reach the server, and the island shows no Jarvis sessions — everything else in Coucou is unaffected.
