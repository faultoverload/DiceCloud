# Library-insert smoke test

Checks that copying library content onto a character works on a built image. It exists
because that path was broken on `develop`: the copies were stored with the library as
their root, so nothing appeared on the sheet.

```bash
docker/smoke-test/run.sh ghcr.io/faultoverload/dicecloud:latest
```

`run.sh` starts the image beside a throwaway MongoDB on a private Docker network, waits
for the app, runs `smoke.mjs`, checks the database, and removes everything it started.
It needs Docker and Node 22 or newer. It never touches an existing DiceCloud instance.

## What it does

As a new user on an empty database, over the same websocket protocol the web client uses:

1. Creates a library containing a ruleset (a folder tagged `base` that fills slots), a
   plain child, and references, including a reference inside a referenced subtree and a
   top-level reference.
2. Creates a character. With exactly one ruleset available the server inserts it into the
   Ruleset slot automatically.
3. Calls `creatureProperties.insertPropertyFromLibraryNode` twice more, once into the slot
   and once at the character's root. That is the call the fill-slot and
   insert-from-library dialogs make.

## What it checks

| Check | Meaning |
|---|---|
| Ruleset copied on character creation | The automatic insert landed on the character |
| Copies hang off the right parents | Ruleset under the slot, children under the ruleset, each reference replaced by its target where the reference was |
| Every property rooted in the character | Nothing is filed under the library |
| Nine properties came from the library | Nothing missing, nothing duplicated |
| No reference nodes copied | Every reference was resolved |
| Tree numbering consistent | `left`/`right` rebuilt, children inside their parents |
| Ruleset slot reports itself filled | The sheet's computation sees the new properties |
| Database: nothing rooted outside a creature | No stranded copies in `creatureProperties` |

A failing run prints the last 60 lines of the app log.
