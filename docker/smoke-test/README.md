# Smoke test

Checks, on a built image, that copying library content onto a character works and that the
copied properties behave. It exists because these paths were broken on `develop`:

- copies were stored with the library as their root, so nothing appeared on the sheet;
- a point buy never worked out what its rows cost;
- a trigger fired whether or not its condition was true;
- a buff remover logged the removal but removed nothing.

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
4. Adds a point buy and a cut-down copy of the community libraries' "Standard Array"
   filler: a buff holding an action that sets a score from a list and moves an index
   along, and a trigger with a condition that removes the buff once the list is used up.
5. Runs that action three times with `actions.insertAction` and `actions.runAction`, the
   calls the sheet makes when an action button is pressed.

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
| Point buy costs | Each row's cost, the total spent and the points left are computed; a row without a value does not stop the rest |
| Each run sets the next score | The action's adjustments apply, and the second one sees the first one's result |
| Trigger with a false condition does not fire | Nothing from the trigger is logged on the first two runs |
| Trigger fires once its condition is true | The third run logs the trigger and the removal |
| Buff remover takes the buff off the sheet | The buff and everything under it is marked removed |
| Last score kept | Removing the buff leaves the score it set |
| Database: nothing rooted outside a creature | No stranded copies in `creatureProperties` |

A failing run prints the last 60 lines of the app log.
