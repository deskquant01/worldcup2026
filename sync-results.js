#!/usr/bin/env node
// Pulls finished World Cup 2026 results from ESPN's public API (no key required)
// and writes them into the Supabase wc2026 table.

const SUPABASE_URL = 'https://yeoygxfdwqjrpqiqrgkz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inllb3lneGZkd3FqcnBxaXFyZ2t6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNjYxNzUsImV4cCI6MjA5Njc0MjE3NX0.ydwDlzztpxN8v3gFPXCJTp2hoAICNRjFsUZ3Dyp9NOk';

const ESPN_SCOREBOARD =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';

// ── Knockout round detection by match date ───────────────────────────────────
// (ESPN type abbreviations are unreliable; dates are authoritative)
const ROUND_BY_DATE = [
  { from: '2026-06-28', to: '2026-07-01', id: 'r32'   },
  { from: '2026-07-03', to: '2026-07-06', id: 'r16'   },
  { from: '2026-07-09', to: '2026-07-10', id: 'qf'    },
  { from: '2026-07-13', to: '2026-07-14', id: 'sf'    },
  { from: '2026-07-18', to: '2026-07-18', id: 'tp'    },
  { from: '2026-07-19', to: '2026-07-19', id: 'final' },
];

function getRoundId(dateStr) {
  const d = dateStr.slice(0, 10); // 'YYYY-MM-DD'
  for (const { from, to, id } of ROUND_BY_DATE) {
    if (d >= from && d <= to) return id;
  }
  return null; // group stage
}

// ── Team name normalization ──────────────────────────────────────────────────
const ALIASES = {
  'Korea Republic':               'South Korea',
  'South Korea':                  'South Korea',
  'Czech Republic':               'Czech Rep.',
  'Czechia':                      'Czech Rep.',
  'Bosnia and Herzegovina':       'Bosnia & Herz.',
  'Bosnia & Herzegovina':         'Bosnia & Herz.',
  'Bosnia-Herzegovina':           'Bosnia & Herz.',
  'Ivory Coast':                  "Côte d'Ivoire",
  "Cote d'Ivoire":                "Côte d'Ivoire",
  'Cape Verde':                   'Cabo Verde',
  'Congo DR':                     'DR Congo',
  'Democratic Republic of Congo': 'DR Congo',
  'DR Congo':                     'DR Congo',
  'Curacao':                      'Curaçao',
  'United States':                'USA',
};
const norm = n => ALIASES[n] ?? n;

// ── App group structure ──────────────────────────────────────────────────────
const GROUPS = {
  A: ['Mexico',      'South Africa',  'South Korea',   'Czech Rep.'],
  B: ['Canada',      'Bosnia & Herz.','Qatar',         'Switzerland'],
  C: ['Brazil',      'Morocco',       'Haiti',         'Scotland'],
  D: ['USA',         'Paraguay',      'Australia',     'Turkey'],
  E: ['Germany',     'Curaçao',       "Côte d'Ivoire", 'Ecuador'],
  F: ['Netherlands', 'Japan',         'Sweden',        'Tunisia'],
  G: ['Belgium',     'Egypt',         'Iran',          'New Zealand'],
  H: ['Spain',       'Cabo Verde',    'Saudi Arabia',  'Uruguay'],
  I: ['France',      'Senegal',       'Iraq',          'Norway'],
  J: ['Argentina',   'Algeria',       'Austria',       'Jordan'],
  K: ['Portugal',    'DR Congo',      'Uzbekistan',    'Colombia'],
  L: ['England',     'Croatia',       'Ghana',         'Panama'],
};

const TEAM_LOC = {};
for (const [g, teams] of Object.entries(GROUPS))
  teams.forEach((t, i) => { TEAM_LOC[t] = { g, i }; });

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function fetchESPN(url) {
  console.log(`  GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status} for ${url}`);
  return res.json();
}

async function sbGet() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/wc2026?id=eq.state&select=data`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  return rows?.[0]?.data ?? null;
}

async function sbPatch(data) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/wc2026?id=eq.state`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ data }),
    }
  );
  if (!res.ok) throw new Error(`Supabase PATCH failed: ${res.status}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const state = await sbGet();
  if (!state) { console.error('State row not found in Supabase'); process.exit(1); }

  // Fetch all WC 2026 matches (group stage + knockout) in one call
  const url = `${ESPN_SCOREBOARD}?dates=20260611-20260720&limit=500`;
  const data = await fetchESPN(url);

  const allEvents = data.events ?? [];
  const finished  = allEvents.filter(e => e.status?.type?.completed === true);
  console.log(`ESPN: ${allEvents.length} total events, ${finished.length} completed`);

  if (!finished.length) { console.log('No finished matches yet'); return; }

  // ── Build group results ────────────────────────────────────────────────────
  const groups   = structuredClone(state.groups ?? {});
  const knockout = structuredClone(state.knockout);

  for (const event of finished) {
    const comp    = event.competitions?.[0];
    if (!comp) continue;

    const home    = comp.competitors?.find(c => c.homeAway === 'home');
    const away    = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) continue;

    const t1      = norm(home.team.displayName);
    const t2      = norm(away.team.displayName);
    const s1      = parseInt(home.score ?? '0', 10);
    const s2      = parseInt(away.score ?? '0', 10);
    const dateStr = event.date ?? '';         // ISO format: "2026-06-12T19:00Z"
    const roundId = getRoundId(dateStr);

    // Detect group via competition notes (ESPN puts "Group A" etc. in notes)
    const groupNote = comp.notes?.find(n => /^Group [A-L]$/i.test(n.headline ?? ''));
    const isGroup   = !!groupNote || roundId === null;

    if (isGroup) {
      // ── Group stage ──
      const groupLetter = groupNote
        ? groupNote.headline.split(' ')[1].toUpperCase()
        : null;

      if (!groupLetter) {
        // Try to infer group from team locations
        const l1 = TEAM_LOC[t1], l2 = TEAM_LOC[t2];
        if (!l1 || !l2 || l1.g !== l2.g) {
          console.warn(`  Skipping (no group): ${t1} vs ${t2}`);
          continue;
        }
        processGroupResult(groups, l1.g, t1, t2, s1, s2);
      } else {
        processGroupResult(groups, groupLetter, t1, t2, s1, s2);
      }
    } else {
      // ── Knockout stage ──
      const hasPens    = s1 === s2; // equal after FT/ET → went to pens
      const pensWinner = hasPens
        ? (home.winner ? '1' : '2')
        : false;

      const roundObj = knockout?.find(r => r.id === roundId);
      if (!roundObj) { console.warn(`  No round object for ${roundId}`); continue; }

      let slot = roundObj.matches.find(m =>
        (m.t1 === t1 && m.t2 === t2) || (m.t1 === t2 && m.t2 === t1)
      ) ?? roundObj.matches.find(m => m.t1 === 'TBD' && m.t2 === 'TBD');

      if (!slot) { console.warn(`  No slot for ${roundId}: ${t1} vs ${t2}`); continue; }

      slot.t1   = t1;
      slot.t2   = t2;
      slot.s1   = s1;
      slot.s2   = s2;
      slot.pens = pensWinner;
      console.log(`  ${roundId}: ${t1} ${s1}-${s2} ${t2}${hasPens ? ' (pens)' : ''}`);
    }
  }

  await sbPatch({ ...state, groups, knockout });
  console.log('Done — Supabase updated.');
}

function processGroupResult(groups, groupLetter, t1, t2, s1, s2) {
  const l1 = TEAM_LOC[t1];
  const l2 = TEAM_LOC[t2];
  if (!l1 || !l2) {
    console.warn(`  Unknown team: ${!l1 ? t1 : t2}`);
    return;
  }
  if (l1.g !== groupLetter || l2.g !== groupLetter) {
    console.warn(`  Group mismatch: ${t1}(${l1.g}) vs ${t2}(${l2.g}), expected ${groupLetter}`);
    return;
  }

  if (!groups[groupLetter]) groups[groupLetter] = [];
  const [i1, i2, sc1, sc2] = l1.i < l2.i
    ? [l1.i, l2.i, s1, s2]
    : [l2.i, l1.i, s2, s1];

  const exists = groups[groupLetter].some(r => r[0] === i1 && r[1] === i2);
  if (!exists) {
    groups[groupLetter].push([i1, i2, sc1, sc2]);
    console.log(`  Group ${groupLetter}: ${t1} ${s1}-${s2} ${t2}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
