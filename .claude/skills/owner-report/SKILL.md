---
name: owner-report
description: The Developer's fixed way to report to the project owner over Telegram (a Rich Message via tg_rich.py with the fixed template, when to report, what must be in a merge/build/decision message). Use for every substantive message to the owner (merge into dev, build or restart done, a decision needed, a task finished). The plugin reply tool is only for one-line answers and files.
---

# owner-report

The format source is `/Volumes/Samsung T9/YouTube/00 YT Operator/System/TELEGRAM_FORMAT.md` (owner TG 3356–3399).
Read it if anything here seems to disagree; it wins.

## Send

1. Write the message as Markdown to a file in the scratchpad.
2. Send it: `python3 "/Volumes/Samsung T9/YouTube/00 YT Operator/90 Scripts/tg_rich.py" --bot telegram <file.md>`.
   Add `--reply-to <message id>` when it answers an owner message.
3. The script prints `ok <id>` (rich) or `plain <id>` (fallback). Note the id: it is the TG number you cite later.
4. For a one-line answer or a file attachment, use the Telegram plugin `reply` tool to chat_id `331110302` (his DM).

## Template

```markdown
# <Тема> · <DD.MM>
One line of context, if needed.

## ✅ Готово
- what shipped: merge sha, what it does for him (not how)

## ⏳ В работе
- what runs now, and only if something really runs (a background job or loop), never "продолжаю" otherwise

## ❓ Нужно ваше решение
- [ ] one decision per line, with my recommendation first
```

Rules:
- Write in Russian, short, and skip empty blocks.
- Use tables when there are several items with statuses.
- Put commands for him in a ```bash block.
- Put long details in `<details>`.
- Embed an image with `КАРТИНКА: <absolute path> | подпись`.
- Code identifiers stay in English.

## What a message must carry

- **Merge into dev** (AGENTS.md §I standing rule): the merge sha, that `dev` was pushed, and the test/lint/build
  counts actually seen in this session. Say what was not rerun.
- **Build or restart:** the version and schema it came back with (from `factory_restart_status` or the card).
- **Merge question for a substantive feature:** what is finished, how it was verified, and an explicit question.
  Merge only on an explicit yes («да, мерджи»); «ок» is not a yes.
- **Decisions:** options with a recommendation and what each costs, as `- [ ]` lines.

## When not to message

- A night-restart session (`[auto] Night restart…`) does not message him unless he wrote first.
- Step pings are wanted (owner TG 4597): after each meaningful step of ongoing work, send one plain `reply` line
  saying what finished and what comes next. Save the rich template for the milestone.
- Peer questions (Operator/Producer) go to them, not to him; tell him only what he must decide.

After sending, record the TG id in the open-items memory line for that thread.
