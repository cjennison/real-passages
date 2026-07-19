# Real Passages

Interactive, DM-authorized **passages** — stairs, elevators, chutes, ladders, portals — for [Foundry VTT](https://foundryvtt.com/) (dnd5e).

Managing movement between floors and locations is tedious: normally a player can't take the stairs themselves, so the DM has to drag every token around. **Real Passages** turns any spot on the map into a clickable marker that a player can use to move themselves to a linked destination — on the **same scene** or a **different scene** — with optional DM approval, skill checks, and traps.

## How it works

1. **Create a marker.** As GM, open the Token scene controls and click **Create Real Passage**. A marker (a small stairs token) drops on the map. Its configuration sheet opens.
2. **Link it.** Create a second marker at the destination (e.g. the second floor, or a spot on another scene), then set each marker's **Links To** the other. Tick **two-way** to auto-link the partner back.
3. **Gate it (optional).**
   - **Requires DM approval** — the player's use request pops an approve / deny / force dialog for the DM.
   - **Skill Check + DC** — the player's character auto-rolls (e.g. Athletics vs DC 12 to climb).
   - **Trap Damage** — a formula + damage type applied on a failed check.
   - **Failure still lets them through** — for hazards you can push past (taking the damage but still crossing).
4. **Use it.** A player double-clicks the marker and presses **Use Passage**. On success their token is moved to the linked marker; across scenes their token is created on the target scene and they are pulled there automatically.

## DM controls

- **Lock** — temporarily block a passage (e.g. after an elevator is called away). Reopen it any time.
- **Collapse** — permanently block a passage (a caved-in tunnel).
- **Reopen** — clear a locked/collapsed state.
- **Free Traversal** — authorize specific players to cross a passage at will, with no approval or check (great once a route is "known").

## Requirements

- Foundry VTT v13+ (verified on v14).
- dnd5e system (skill checks and trap damage use dnd5e data).
- An **active GM** must be connected — the GM's client authoritatively moves tokens and pulls players across scenes.

## Notes

- Passage markers are neutral, unlinked NPC tokens with `sight` disabled, so they don't act as creatures or block vision.
- Events (`real-passages.traversed`, `.failed`, `.locked`, `.collapsed`, `.reopened`) are broadcast as Foundry hooks and can drive [Connection Manager](https://github.com/cjennison/connection-manager) automations (e.g. AI narration).

## License

MIT
