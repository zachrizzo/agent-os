// Creature avatars: lookup (agent id, session key, you/zach, parent fallback), the state class, the generic blob, and that the inlined SVGs are inert (no scripts, no links).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/agent-os/' });
Object.assign(globalThis, { document: dom.window.document });
const { CREATURES, CREATURE_STYLE } = await import('./creatures.gen.ts');
const { CREATURE_STATES, creatureClass, creatureKey, creatureKeyFor, creatureSvg } = await import('./creature.ts');
const { avatarForAgent, avatarHtml } = await import('./format.ts');

test('every creature is an inert, animated SVG: no scripts, links or event handlers; the animation CSS is shared and honours reduced motion', () => {
  assert.ok(Object.keys(CREATURES).length >= 34);
  for (const k of ['zach', 'main', 'coder', 'agent-service-coder', 'rfc-doug']) assert.ok(CREATURES[k], k);
  assert.equal(CREATURES.phi, undefined, 'there is no creature for phi');
  for (const [k, [open, inner]] of Object.entries(CREATURES)) {
    const svg = creatureSvg(k);
    assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>'), k);
    assert.ok(!/<script|\son\w+\s*=|href=|<foreignObject|<image/i.test(svg), `${k} must be inert`);
    assert.ok(/class="(hop|calm|scan|tidy|chat)"/.test(open), `${k} has a personality class on the root`);
    assert.ok(inner.includes('class="bang"') && inner.includes('class="b"'), k);
  }
  assert.match(CREATURE_STYLE, /@media \(prefers-reduced-motion:reduce\)\{\*\{animation:none!important\}\}/);
  assert.ok(CREATURE_STYLE.indexOf('.st-error') < CREATURE_STYLE.indexOf('prefers-reduced-motion'), 'state rules come before the reduced-motion override');
});

test('the default creature is exactly the file as generated: a state only adds a class to the root', () => {
  const plain = creatureSvg('coder');
  assert.ok(!/st-(active|idle|needs|error)/.test(plain.replace(/\.st-[a-z]+/g, '')), 'no state class by default');
  for (const st of CREATURE_STATES) {
    const s = creatureSvg('coder', st);
    assert.equal(s.replace(` st-${st}"`, '"'), plain, st);
    assert.match(s, new RegExp(`^<svg [^>]*class="[a-z]+ st-${st}"`));
  }
});

test('lookup: agent id, session key, you/zach, unknown ids; subagents fall back to their parent', () => {
  assert.equal(creatureKey('agent-service-coder'), 'agent-service-coder');
  assert.equal(creatureKey('agent:main:subagent:abc'), 'main');
  assert.equal(creatureKey('you'), 'zach');
  assert.equal(creatureKey('zach'), 'zach');
  assert.equal(creatureKey('phi'), '');
  assert.equal(creatureKey('agent:phi:main'), '');
  assert.equal(creatureKey('toString'), '', 'prototype keys are not creatures');
  assert.equal(creatureKey(undefined), '');
  const fleet = new Map([
    ['agent:coder:main', { id: 'agent:coder:main', agentId: 'coder' }],
    ['agent:coder:subagent:1', { id: 'agent:coder:subagent:1', agentId: 'ghost', parent: 'agent:coder:main' }],
    ['cron:9', { id: 'cron:9', parent: 'agent:coder:subagent:1' }],
    ['orphan', { id: 'orphan', agentId: 'ghost' }],
    ['loop-a', { id: 'loop-a', parent: 'loop-b' }], ['loop-b', { id: 'loop-b', parent: 'loop-a' }],
  ]);
  const get = (id: string) => fleet.get(id);
  assert.equal(creatureKeyFor(get('agent:coder:main'), get), 'coder');
  assert.equal(creatureKeyFor(get('agent:coder:subagent:1'), get), 'coder', 'a subagent whose agent has no creature uses its parent');
  assert.equal(creatureKeyFor(get('cron:9'), get), 'coder', 'two hops up');
  assert.equal(creatureKeyFor(get('orphan'), get), '');
  assert.equal(creatureKeyFor(get('loop-a'), get), '', 'a parent cycle ends');
});

test('avatarHtml: a creature span with its state class; a plain blob in the given colour when there is no creature; names are escaped', () => {
  const a = avatarHtml('coder', 'Coder', '🧰');
  assert.match(a, /class="avatar cr cr-coder "/);
  assert.ok(!a.includes('🧰') && !a.includes('>C<'), 'no emoji or initial');
  assert.match(avatarHtml('coder', 'Coder', undefined, 'sm', { status: 'needs' }), /class="avatar cr cr-coder-needs sm"/);
  assert.match(avatarHtml('you', 'You'), /cr-zach/);
  const blob = avatarHtml('mystery', 'M <b>', undefined, 'sm', { hue: '#123456' });
  assert.match(blob, /class="avatar blob sm" style="--hue:#123456"/);
  assert.ok(!blob.includes('<b>') && blob.includes('M &#60;b&#62;'));
  assert.match(avatarHtml('mystery', 'M'), /--hue:#[0-9a-f]{6}/i, 'a default colour from the id');
});

test('each creature+state is added to the page once, as a data-URI background; reduced motion is inside the image', () => {
  creatureClass('main', 'idle'); creatureClass('main', 'idle'); creatureClass('main');
  const css = dom.window.document.getElementById('creature-css')!.textContent!;
  assert.equal((css.match(/\.avatar\.cr-main-idle\{/g) ?? []).length, 1);
  assert.equal((css.match(/\.avatar\.cr-main\{/g) ?? []).length, 1);
  const url = /\.avatar\.cr-main-idle\{background-image:url\("data:image\/svg\+xml;charset=utf-8,([^"]+)"\)\}/.exec(css)![1];
  const svg = decodeURIComponent(url);
  assert.equal(svg, creatureSvg('main', 'idle'));
  assert.match(svg, /st-idle/);
});

test('avatarForAgent: own creature, else the parent\'s, else a blob in the team colour; status picks the look', () => {
  const agents = new Map<string, Record<string, unknown>>([
    ['agent:coder:main', { id: 'agent:coder:main', agentId: 'coder', name: 'Coder', team: 't', status: 'active' }],
    ['sub', { id: 'sub', agentId: 'nobody', name: 'worker', team: 't', parent: 'agent:coder:main', status: 'error' }],
    ['lost', { id: 'lost', name: 'lost', agentName: 'Lost one', team: 't', status: 'idle' }],
  ]);
  const s = { agentsAll: agents, teamsById: new Map([['t', { hue: '#abcdef' }]]) } as never;
  assert.match(avatarForAgent(s, agents.get('agent:coder:main') as never), /cr-coder-active/);
  assert.match(avatarForAgent(s, agents.get('sub') as never), /cr-coder-error/);
  const lost = avatarForAgent(s, agents.get('lost') as never);
  assert.match(lost, /avatar blob/);
  assert.match(lost, /--hue:#abcdef/);
  assert.match(lost, /Lost one/);
});
