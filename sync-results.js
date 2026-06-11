#!/usr/bin/env node
// Pulls finished World Cup 2026 results from api-football.com
// and writes them into the Supabase wc2026 table.
//
// Required env var:
//   API_FOOTBALL_KEY  — from api-football.com (free tier: 100 req/day)

const SUPABASE_URL = 'https://yeoygxfdwqjrpqiqrgkz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inllb3lneGZkd3FqcnBxaXFyZ2t6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNjYxNzUsImV4cCI6MjA5Njc0MjE3NX0.ydwDlzztpxN8v3gFPXCJTp2hoAICNRjFsUZ3Dyp9NOk';
const API_KEY      = process.env.API_FOOTBALL_KEY;
const LEAGUE_ID    = 1;    // FIFA World Cup on api-football.com
const SEASON       = 2026;

if (!API_KEY) { console.error('API_FOOTBALL_KEY env var is required'); process.exit(1); }

// ── Team name normalization ──────────────────────────────────────────────────
// Maps api-football team names → app team names
const ALIASES = {
  'Korea Republic':               'South Korea',
  'Czech Republic':               'Czech Rep.',
  'Bosnia and Herzegovina':       'Bosnia & Herz.',
  'Bosnia & Herzegovina':         'Bosnia & Herz.',
  'Ivory Coast':                  "Côte d'Ivoire",
  "Cote d'Ivoire":                "Côte d'Ivoire",
  'Cape Verde':                   'Cabo Verde',
  'Congo DR':                     'DR Congo',
  'Democratic Republic of Congo': 'DR Congo',
  'Curacao':                      'Curaçao',
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

// team → { g: letter, i: index }
const TEAM_LOC = {};
for (const [g, teams] of Object.entries(GROUPS))
  teams.forEach((t, i) => { TEAM_LOC[t] = { g, i }; });

// ── Knockout round name → app round id ──────────────────────────────────────
const ROUND_ID = {
  'Round of 32':      'r32',  '1/16-finals':     'r32',
  'Round of 16':      'r16',  '1/8-finals':      'r16',
  'Quarter-finals':   'qf',   'Quarter Finals':  'qf',
  'Semi-finals':      'sf',   'Semi Finals':     'sf',
  '3rd Place Final':  'tp',   '3rd place final': 'tp',
  'Final':            'final',
};

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { 'x-apisports-key': API_KEY },
  });
  if (!res.ok) throw new Error(`API error ${res.status} for ${path}`);
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
  // Load current state from Supabase
  const state = await sbGet();
  if (!state) { console.error('State row not found in Supabase'); process.exit(1); }

  // Fetch all finished fixtures for WC 2026 in one call
  const { response: fixtures, errors } = await apiFetch(
    `/fixtures?league=${LEAGUE_ID}&season=${SEASON}&status=FT-AET-PEN`
  );

  if (errors?.length) { console.error('API errors:', errors); process.exit(1); }
  if (!fixtures?.length) { console.log('No finished fixtures yet'); return; }

  console.log(`Processing ${fixtures.length} finished fixture(s)…`);

  // ── Build group results ────────────────────────────────────────────────────
  const groups = structuredClone(state.groups ?? {});

  for (const fx of fixtures) {
    if (!fx.league.round.startsWith('Group')) continue;

    const t1 = norm(fx.teams.home.name);
    const t2 = norm(fx.teams.away.name);
    const l1 = TEAM_LOC[t1];
    const l2 = TEAM_LOC[t2];
    if (!l1 || !l2 || l1.g !== l2.g) {
      console.warn(`  Unknown/mismatched group teams: ${t1} vs ${t2}`);
      continue;
    }

    const s1raw = fx.score.fulltime.home;
    const s2raw = fx.score.fulltime.away;
    if (s1raw === null || s2raw === null) continue;

    const g = l1.g;
    if (!groups[g]) groups[g] = [];

    // Always store with lower index first (matches app convention)
    const [i1, i2, sc1, sc2] = l1.i < l2.i
      ? [l1.i, l2.i, s1raw, s2raw]
      : [l2.i, l1.i, s2raw, s1raw];

    const exists = groups[g].some(r => r[0] === i1 && r[1] === i2);
    if (!exists) {
      groups[g].push([i1, i2, sc1, sc2]);
      console.log(`  Group ${g}: ${t1} ${sc1}-${sc2} ${t2}`);
    }
  }

  // ── Build knockout results ─────────────────────────────────────────────────
  const knockout = structuredClone(state.knockout);

  for (const fx of fixtures) {
    const roundId = ROUND_ID[fx.league.round];
    if (!roundId) continue;

    const t1 = norm(fx.teams.home.name);
    const t2 = norm(fx.teams.away.name);

    // Score = fulltime + any extra time
    const s1 = (fx.score.fulltime.home ?? 0) + (fx.score.extratime.home ?? 0);
    const s2 = (fx.score.fulltime.away ?? 0) + (fx.score.extratime.away ?? 0);
    if (fx.score.fulltime.home === null) continue;

    const hasPens   = fx.score.penalty.home !== null;
    const pensWinner = hasPens
      ? (fx.score.penalty.home > fx.score.penalty.away ? '1' : '2')
      : false;

    const roundObj = knockout?.find(r => r.id === roundId);
    if (!roundObj) continue;

    // Find slot: exact team match, reversed match, or first empty TBD slot
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

  // ── Write back ────────────────────────────────────────────────────────────
  await sbPatch({ ...state, groups, knockout });
  console.log('Done — Supabase updated.');
}

main().catch(err => { console.error(err); process.exit(1); });
