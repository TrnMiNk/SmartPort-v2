'use strict';

// UC-015 validation policy: pure and deterministic. The same snapshot and the same policy configuration always give
// the same outcome, reason codes and reason text. No clock, randomness or I/O is used here; everything the decision
// depends on is in `snapshot`, which is stored with every run (rule 06).
//
// Rules (fixed in code, version RULES_VERSION). The policy CONFIGURATION (stored, versioned, checksummed) chooses
// which documents are required. Source of each rule: docs/policies/uc015-uc020-policy-v1.md.
//   R01 REQUIRED_FIELDS            effect MISSING   spec step 1 "đủ trường bắt buộc"
//   R02 IMO_FORMAT                 effect MISSING   spec step 1 "định dạng IMO"; 1a "thiếu/sai hồ sơ"
//   R03 VESSEL_ACTIVE              effect REJECT    UC-011 rule: an inactive vessel takes no new notice
//   R04 VESSEL_NOT_RESTRICTED      effect REJECT    spec 1b "tàu thuộc danh sách cấm/hạn chế"
//   R05 DOCUMENTS_PRESENT_APPROVED effect MISSING   spec 1a "thiếu/sai hồ sơ"; UC-012 review status
//   R06 DOCUMENTS_VALID_AT_ETA     effect REJECT    spec 1b "giấy tờ hết hiệu lực"
// Precedence: any REJECT failure gives REJECTED; otherwise any MISSING failure gives MISSING_DOCUMENTS; otherwise VALID.

const RULES_VERSION = 'UC015-RULES-V1';
const UTC7_MS = 7 * 60 * 60 * 1000;
const SCOPES = ['SHIP', 'VOYAGE'];

const REASONS = {
  MISSING_REQUIRED_FIELD: 'Thiếu trường bắt buộc',
  INVALID_IMO: 'Số IMO sai định dạng',
  VESSEL_INACTIVE: 'Tàu đã bị vô hiệu hóa',
  VESSEL_PROHIBITED: 'Tàu thuộc danh sách cấm',
  VESSEL_RESTRICTED: 'Tàu thuộc danh sách hạn chế',
  DOCUMENT_MISSING: 'Thiếu giấy tờ bắt buộc',
  DOCUMENT_NOT_APPROVED: 'Giấy tờ bắt buộc chưa được thẩm định đạt',
  DOCUMENT_EXPIRED: 'Giấy tờ bắt buộc đã hết hiệu lực',
  DOCUMENT_NOT_YET_VALID: 'Giấy tờ bắt buộc chưa có hiệu lực',
};

class PolicyError extends Error {
  constructor(message) { super(message); this.name = 'PolicyError'; }
}

// Validates and normalizes a stored policy configuration. Throws PolicyError when it is unusable (fail closed).
function parsePolicy(json) {
  let config;
  try { config = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { throw new PolicyError('policy is not valid JSON'); }
  if (!config || typeof config !== 'object' || !Array.isArray(config.requiredDocuments)) throw new PolicyError('requiredDocuments is missing');
  const seen = new Set();
  const required = config.requiredDocuments.map((r) => {
    if (!r || typeof r.type !== 'string' || !/^[A-Z][A-Z0-9_]{0,39}$/.test(r.type) || !SCOPES.includes(r.scope)) {
      throw new PolicyError('invalid required document entry');
    }
    const key = `${r.type}|${r.scope}`;
    if (seen.has(key)) throw new PolicyError('duplicate required document entry');
    seen.add(key);
    return { type: r.type, scope: r.scope };
  });
  required.sort((a, b) => (a.type + a.scope).localeCompare(b.type + b.scope));
  return { requiredDocuments: required };
}

// Calendar date (YYYY-MM-DD) of an instant in UTC+7, the display zone in the specification.
function etaDateUtc7(iso) {
  if (iso === null || iso === undefined || iso === '') return null; // new Date(null) would silently be 1970
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : new Date(t + UTC7_MS).toISOString().slice(0, 10);
}

function classifyDocument(req, snapshot, etaDate) {
  const { voyage, documents } = snapshot;
  const candidates = documents.filter((d) => d.document_type_code === req.type
    && (req.scope === 'SHIP' ? d.voyage_id == null || d.voyage_id === voyage.id : d.voyage_id === voyage.id));
  if (candidates.length === 0) return 'DOCUMENT_MISSING';
  const approved = candidates.filter((d) => d.review_status === 'APPROVED');
  if (approved.length === 0) return 'DOCUMENT_NOT_APPROVED';
  const covering = approved.some((d) => (!d.valid_from || d.valid_from <= etaDate) && (!d.valid_until || d.valid_until >= etaDate));
  if (covering) return 'OK';
  return approved.some((d) => d.valid_until && d.valid_until < etaDate) ? 'DOCUMENT_EXPIRED' : 'DOCUMENT_NOT_YET_VALID';
}

const rule = (id, effect, failures) => ({ id, effect, status: failures.length ? 'FAIL' : 'PASS', failures });

function evaluate(policyConfig, snapshot) {
  const policy = parsePolicy(policyConfig);
  const { voyage, ship } = snapshot;
  const etaDate = etaDateUtc7(voyage.declared_eta);

  const missingFields = [];
  if (!voyage.voyage_code) missingFields.push('voyage_code');
  if (etaDate === null) missingFields.push('declared_eta');
  if (!Number.isInteger(voyage.declared_teu) || voyage.declared_teu < 0) missingFields.push('declared_teu');
  if (!voyage.cargo_type || !String(voyage.cargo_type).trim()) missingFields.push('cargo_type');
  if (!voyage.origin_port_id) missingFields.push('origin_port_id');
  if (!voyage.agent_id) missingFields.push('agent_id');

  const f = (code, detail) => ({ code, detail });
  const r01 = rule('R01', 'MISSING', missingFields.sort().map((name) => f('MISSING_REQUIRED_FIELD', name)));
  const r02 = rule('R02', 'MISSING', /^[0-9]{7}$/.test(String(ship.imo_number || '')) ? [] : [f('INVALID_IMO', String(ship.imo_number || ''))]);
  const r03 = rule('R03', 'REJECT', ship.is_active ? [] : [f('VESSEL_INACTIVE', ship.imo_number)]);

  const active = (etaDate === null ? [] : (snapshot.restrictions || []).filter((x) =>
    x.valid_from <= etaDate && (!x.valid_until || x.valid_until >= etaDate)));
  const r04 = rule('R04', 'REJECT', active
    .map((x) => f(x.restriction_type === 'PROHIBITED' ? 'VESSEL_PROHIBITED' : 'VESSEL_RESTRICTED', x.reason))
    .sort((a, b) => (a.code + a.detail).localeCompare(b.code + b.detail)));

  const statuses = etaDate === null ? [] : policy.requiredDocuments.map((req) => ({ req, code: classifyDocument(req, snapshot, etaDate) }));
  const detail = (x) => `${x.req.type}/${x.req.scope}`;
  const r05 = rule('R05', 'MISSING', statuses.filter((s) => s.code === 'DOCUMENT_MISSING' || s.code === 'DOCUMENT_NOT_APPROVED').map((s) => f(s.code, detail(s))));
  const r06 = rule('R06', 'REJECT', statuses.filter((s) => s.code === 'DOCUMENT_EXPIRED' || s.code === 'DOCUMENT_NOT_YET_VALID').map((s) => f(s.code, detail(s))));

  const rules = [r01, r02, r03, r04, r05, r06];
  const failures = (effect) => rules.filter((r) => r.effect === effect).flatMap((r) => r.failures);
  const rejects = failures('REJECT');
  const missing = failures('MISSING');
  const outcome = rejects.length ? 'REJECTED' : missing.length ? 'MISSING_DOCUMENTS' : 'VALID';
  // The reason lists the failures of the deciding effect only, in rule order, so equal inputs give equal text.
  const deciding = outcome === 'REJECTED' ? rejects : outcome === 'MISSING_DOCUMENTS' ? missing : [];
  const reasonCodes = [...new Set(deciding.map((x) => x.code))];
  return {
    engine: RULES_VERSION,
    outcome,
    reasonCode: reasonCodes[0] || null,
    reasonCodes,
    reason: deciding.length ? deciding.map((x) => `${REASONS[x.code]} (${x.detail})`).join('; ') : null,
    rules,
    etaDate,
  };
}

module.exports = { RULES_VERSION, REASONS, PolicyError, parsePolicy, evaluate, etaDateUtc7 };
