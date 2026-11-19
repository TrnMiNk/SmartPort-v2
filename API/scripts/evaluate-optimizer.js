'use strict';

// Offline comparison of the UC-027 policies with a first-fit baseline on CONSTRUCTED, seeded scenarios. Reads and writes no database.
//   node scripts/evaluate-optimizer.js [seedsPerProfile=40]
// Every variant receives the identical snapshot. Variants: FIRST_FIT (earliest feasible start, berth code order: a model of a coordinator, NOT real manual
// data), V1 (greedy by cost) and V2 (beam search, current). Four load profiles are used so that no single fixture decides the result.
// Reported per profile: mean waiting, mean of the per-scenario worst waiting, the worst single wait, unscheduled vessels, unused berth length, the per-seed
// paired comparison against first-fit (better / equal / worse mean waiting) and the slowest engine run. No UC-026 verification here (pure engine); the
// integration tests verify every proposal with UC-026. None of this is evidence about a real port or about an AI model.

const { recommend, metrics, POLICIES } = require('../src/policy/berthOptimizer');

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const AS_OF = '2031-01-10T00:00:00.000Z';
const H = (h) => new Date(Date.parse(AS_OF) + h * 3600000).toISOString();
const PROFILES = {
  moderate: { spread: 60, berths: 6 }, congested: { spread: 24, berths: 6 }, light: { spread: 150, berths: 6 }, 'few berths': { spread: 48, berths: 3 },
};

function scenario(seed, prof) {
  const r = rng(seed * 7919 + 13);
  const dims = [[450, 5, 15], [400, 4, 14], [350, 4, 13], [300, 3, 12], [300, 3, 12], [250, 2, 11]].slice(0, prof.berths);
  const berths = dims.map(([len, cr, depth], i) => ({ berth_id: i + 1, berth_code: `C${i + 1}`, berth_type: 'CONTAINER', length_m: len, max_depth_m: depth, available_cranes: cr, allows_dangerous: i === 0, operational_status: 'IN_SERVICE' }));
  berths.push({ berth_id: 7, berth_code: 'K7', berth_type: 'BULK', length_m: 280, max_depth_m: 11, available_cranes: 2, allows_dangerous: false, operational_status: 'IN_SERVICE' });
  const vessels = Array.from({ length: 20 }, (_, i) => ({ voyage_id: i + 1, voyage_code: `V${i + 1}`, priority_class: 'STANDARD', effective_eta: H(1 + Math.floor(r() * prof.spread)), eta_source: 'DECLARED',
    loa: Math.round(140 + r() * 130), draft: Math.round((8 + r() * 4) * 10) / 10, cargo_class: r() < 0.15 ? 'BULK' : 'CONTAINER', cargo_hazard: r() < 0.1 ? 'DANGEROUS' : 'NONE', declared_teu: Math.round(300 + r() * 1500) }))
    .sort((a, b) => Date.parse(a.effective_eta) - Date.parse(b.effective_eta)).map((v, i) => ({ ...v, queue_position: i + 1 }));
  const busy = [{ berth_id: 1, from: H(0), to: H(20), position_start_m: 0, position_end_m: 200, voyage_code: 'X' }, { berth_id: 2, from: H(5), to: H(30), position_start_m: 0, position_end_m: 220, voyage_code: 'Y' }];
  return { as_of: AS_OF, buffer_m: 20, vessels, berths, busy, maintenance: [{ berth_id: 3, from: H(10), to: H(36) }] };
}

const VARIANTS = {
  'first-fit': (s) => recommend(s, { selection: 'FIRST_FIT', policy: POLICIES['UC027-OPT-V1'] }),
  'V1 greedy': (s) => recommend(s, { policy: POLICIES['UC027-OPT-V1'] }),
  'V2 beam': (s) => recommend(s, { policy: POLICIES['UC027-OPT-V2'] }),
};

module.exports = { scenario, PROFILES, VARIANTS };

if (require.main === module) {
  (async () => {
    const seeds = Number(process.argv[2] || 40);
    const out = [];
    for (const [pname, prof] of Object.entries(PROFILES)) {
      const rows = {};
      for (const name of Object.keys(VARIANTS)) rows[name] = { m: [], worstMs: 0 };
      for (let seed = 1; seed <= seeds; seed += 1) {
        const s = scenario(seed, prof);
        for (const [name, fn] of Object.entries(VARIANTS)) { const t = process.hrtime.bigint(); const r = await fn(s); rows[name].worstMs = Math.max(rows[name].worstMs, Number(process.hrtime.bigint() - t) / 1e6); rows[name].m.push(metrics(r)); }
      }
      const mean = (list, f) => Math.round(list.reduce((t, m) => t + f(m), 0) / list.length * 100) / 100;
      out.push(`\n${pname}: ${seeds} seeds, 20 vessels, ${prof.berths + 1} berths, ETA spread ${prof.spread} h`);
      out.push(`${'variant'.padEnd(11)}${'mean wait'.padStart(10)}${'mean worst'.padStart(11)}${'max wait'.padStart(9)}${'unsched'.padStart(8)}${'unused len'.padStart(11)}${'vs first-fit (better/equal/worse)'.padStart(36)}${'slowest ms'.padStart(11)}`);
      for (const [name, { m, worstMs }] of Object.entries(rows)) {
        let better = 0; let equal = 0; let worse = 0;
        m.forEach((x, i) => { const d = x.mean_wait_h - rows['first-fit'].m[i].mean_wait_h; if (d < -0.005) better += 1; else if (d > 0.005) worse += 1; else equal += 1; });
        out.push(`${name.padEnd(11)}${String(mean(m, (x) => x.mean_wait_h)).padStart(10)}${String(mean(m, (x) => x.max_wait_h)).padStart(11)}${String(Math.max(...m.map((x) => x.max_wait_h))).padStart(9)}${String(mean(m, (x) => x.unschedulable)).padStart(8)}${String(mean(m, (x) => x.mean_unused_length)).padStart(11)}${(name === 'first-fit' ? '-' : `${better}/${equal}/${worse}`).padStart(36)}${String(Math.round(worstMs * 10) / 10).padStart(11)}`);
      }
    }
    process.stdout.write(out.join('\n') + '\n');
  })();
}
