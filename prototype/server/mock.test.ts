// The mock fleet's room gateway is what the dev server and the harness screenshots run on: its usage, tool and judge stand-ins must behave like the real ones.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMockSource } from './mock.ts';

test('mock rooms: turns report usage, the speak-filter judge skips members nobody @mentioned (and fails open on junk), tool progress shows in the activity list', async () => {
  const src = createMockSource();
  try {
    const rooms = src.rooms;
    const { room } = await rooms.create({ name: 'Mock', members: ['forge', 'spark', 'research'] });
    await rooms.send(room.id, 'plain question');
    await rooms.idle(room.id);
    const plain = await rooms.get(room.id);
    assert.ok(plain.run!.usage!.turns >= 3 && plain.run!.usage!.costUsd > 0 && !plain.run!.usage!.estimated, 'mock turns report real-looking usage');
    const unfilteredTurns = plain.run!.usage!.turns;

    await rooms.update(room.id, { speakFilter: true });
    await rooms.send(room.id, 'filtered question');
    await rooms.idle(room.id);
    const filtered = await rooms.get(room.id);
    assert.ok(filtered.run!.filtered! >= 1, 'the judge skipped members');
    assert.ok(filtered.run!.usage!.turns < unfilteredTurns, `fewer turns with the filter (${filtered.run!.usage!.turns} < ${unfilteredTurns})`);

    await rooms.send(room.id, 'judgefail question');
    await rooms.idle(room.id);
    const failOpen = await rooms.get(room.id);
    assert.equal(failOpen.run!.usage!.turns, unfilteredTurns, 'junk from the judge: everyone speaks, same turns as with no filter');

    await rooms.update(room.id, { speakFilter: false });
    await rooms.send(room.id, 'tools slow');
    const seen = new Set<string>();
    for (let i = 0; i < 120; i++) { await new Promise((r) => setTimeout(r, 100)); for (const a of (await rooms.get(room.id)).run?.activity ?? []) if (a.tool) seen.add(a.tool); if (seen.size) break; }
    assert.ok(seen.has('web_search') || seen.has('exec'), 'a member shows the tool it is using');
    await rooms.stop(room.id); await rooms.idle(room.id);
  } finally { src.close(); }
});
