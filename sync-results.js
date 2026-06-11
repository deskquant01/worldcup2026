#!/usr/bin/env node
// Pulls finished World Cup 2026 results from football-data.org
// and writes them into the Supabase wc2026 table.
//
// Required env var:
//   FOOTBALL_DATA_KEY  — from football-data.org (free tier, register at football-data.org)

const SUPABASE_URL = 'https://yeoygxfdwqjrpqiqrgkz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inllb3lneGZkd3FqcnBxaXFyZ2t6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNjYxNzUsImV4cCI6MjA5Njc0MjE3NX0.ydwDlzztpxN8v3gFPXCJTp2hoAICNRjFsUZ3Dyp9NOk';
const API_KEY      = process.env.FOOTBALL_DATA_KEY;
const COMPETITION  = 'WC'; // football-data.org competition code for FIFA World Cup

if (!API_KEY) { console.error('FOOTBALL_DATA_KEY env var is required'); process.exit(1); }

// ── Team name normalization ──────────────────────────────────────────────────
// Maps football-data.org team names → app team names
const ALIASES = {
  'Korea Republic':                           'South Korea',
  'Republic of Korea':                        'South Korea',
  'Czech Republic':                           'Czech Rep.',
  'Bosnia and Herzegovina':                   'Bosnia & Herz.',
  'Bosnia & Herzegovina':                     'Bosnia & Herz.',
  'Ivory Coast':                              "Côte d'Ivoire",
  "Cote d'Ivoire":                            "Côte d'Ivoire",
  'Cape Verde':                               'Cabo Verde',
  'Congo DR':                                 'DR Congo',
  'Congo, the Democratic Republic of the':    'DR Congo',
  'Democratic Republic of Congo':             'DR Congo',
  'Curacao':                                  'Curaçao',
  'United States':                            'USA',
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

// ── football-data.org stage → app round id ───────────────────────────────────
const STAGE_TO_ROUND = {
  'ROUND_OF_32':    'r32',
  'LAST_16':        'r16',
  'QUARTER_FINALS': 'qf',
  'SEMI_FINALS':    'sf',
  '3RD_PLACE':      'tp',
  'THIRD_PLACE':    'tp',
  'FINAL':          'final',
};

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function apiFetch(path) {
  const url = `https://api.football-data.org/v4${path}`;
  console.log(`  GET ${url}`);
  const res = await fetch(url, { headers: { 'X-Auth-Token': API_KEY } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API error ${res.status}: ${text.slice(0, 200)}`);
  }
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

  console.log(`Fetching finished WC matches from football-data.org…`);
  const data = await apiFetch(`/competitions/${COMPETITION}/matches?status=FINISHED`);
  console.log(`API response: count=${data.count ?? 0}`);

  const matches = data.matches ?? [];
  if (!matches.length) { console.log('No finished fixtures yet'); return; }

  console.log(`Processing ${matches.length} finished match(es)…`);

  // ── Build group results ────────────────────────────────────────────────────
  const groups = structuredClone(state.groups ?? {});

  for (const match of matches) {
    if (match.stage !== 'GROUP_STAGE') continue;

    const t1 = norm(match.homeTeam.name);
    const t2 = norm(match.awayTeam.name);
    const l1 = TEAM_LOC[t1];
    const l2 = TEAM_LOC[t2];
    if (!l1 || !l2 || l1.g !== l2.g) {
      console.warn(`  Unknown/mismatched group teams: ${t1} (${match.homeTeam.name}) vs ${t2} (${match.awayTeam.name})`);
      continue;
    }

    const s1 = (match.score.fullTime.home ?? 0) + (match.score.extraTime?.home ?? 0);
    const s2 = (match.score.fullTime.away ?? 0) + (match.score.extraTime?.away ?? 0);
    if (match.score.fullTime.home === null) continue; // not yet finished

    const g = l1.g;
    if (!groups[g]) groups[g] = [];

    const [i1, i2, sc1, sc2] = l1.i < l2.i
      ? [l1.i, l2.i, s1, s2]
      : [l2.i, l1.i, s2, s1];

    const exists = groups[g].some(r => r[0] === i1 && r[1] === i2);
    if (!exists) {
      groups[g].push([i1, i2, sc1, sc2]);
      console.log(`  Group ${g}: ${t1} ${sc1}-${sc2} ${t2}`);
    }
  }

  // ── Build knockout results ─────────────────────────────────────────────────
  const knockout = structuredClone(state.knockout);

  for (const match of matches) {
    const roundId = STAGE_TO_ROUND[match.stage];
    if (!roundId) continue;

    const t1 = norm(match.homeTeam.name);
    const t2 = norm(match.awayTeam.name);

    const s1 = (match.score.fullTime.home ?? 0) + (match.score.extraTime?.home ?? 0);
    const s2 = (match.score.fullTime.away ?? 0) + (match.score.extraTime?.away ?? 0);
    if (match.score.fullTime.home === null) continue;

    const hasPens   = match.score.duration === 'PENALTY_SHOOTOUT';
    const pensWinner = hasPens
      ? (match.score.penalties.home > match.score.penalties.away ? '1' : '2')
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

  // ── Write back ────────────────────────────────────────────────────────────
  await sbPatch({ ...state, groups, knockout });
  console.log('Done — Supabase updated.');
}

main().catch(err => { console.error(err); process.exit(1); });
