/**
 * Rule Engine — evaluates S/4HANA fixed asset records against configured
 * MonitoringRules and SensitiveFieldConditions.
 *
 * Field name mapping — use these names in rule conditions (fieldName column):
 *   ZUGDT                    → AcquisitionValueDate        (from ledger)
 *   AKTIV                    → AssetCapitalizationDate      (from ledger)
 *   DEAKT                    → AssetDeactivationDate        (from ledger)
 *   XLOEV                    → AssetDeactivationDate        (same as DEAKT, block indicator)
 *   FixedAssetDescription    → FixedAssetDescription
 *   FirstAcquisitionFiscalYear → FirstAcquisitionFiscalYear (from ledger)
 *   AssetLifecycleStatus     → AssetLifecycleStatus
 *   AssetCompletenessStatus  → AssetCompletenessStatus
 */

import * as aiService from './ai-recommendation.js';

const FIELD_MAP = {
  ZUGDT:                    'AcquisitionValueDate',
  AKTIV:                    'AssetCapitalizationDate',
  DEAKT:                    'AssetDeactivationDate',
  XLOEV:                    'AssetDeactivationDate',
  FixedAssetDescription:    'FixedAssetDescription',
  FirstAcquisitionFiscalYear: 'FirstAcquisitionFiscalYear',
  AssetLifecycleStatus:     'AssetLifecycleStatus',
  AssetCompletenessStatus:  'AssetCompletenessStatus',
};

/**
 * Returns the number of calendar days between creationDate and today.
 *
 * @param {string|Date} creationDate  ISO date string or Date object
 * @returns {number}
 */
export function daysSince(creationDate) {
  if (!creationDate) return 0;
  const created = creationDate instanceof Date ? creationDate : new Date(creationDate);
  const now = new Date();
  return Math.floor((now - created) / (1000 * 60 * 60 * 24));
}

/**
 * Checks whether a single field condition is violated by the asset record.
 *
 * @param {object} asset             S/4HANA asset record (flat object)
 * @param {{fieldName:string, conditionType:string, keywordValue?:string}} condition
 * @returns {boolean}  true if the condition is triggered (i.e. asset violates it)
 */
export function evaluateFieldCondition(asset, condition) {
  const apiField = FIELD_MAP[condition.fieldName] || condition.fieldName;
  const value = asset[apiField];

  switch (condition.conditionType) {
    case 'IS_EMPTY':
      return value === null || value === undefined || value === '';

    case 'IS_NOT_EMPTY':
      return value !== null && value !== undefined && value !== '';

    case 'CONTAINS_KEYWORD': {
      if (!condition.keywordValue) return false;
      const haystack = (value || '').toString().toLowerCase();
      return haystack.includes(condition.keywordValue.toLowerCase());
    }

    default:
      return false;
  }
}

/**
 * Checks whether a single rule is violated by the asset record.
 *
 * @param {object} asset    S/4HANA asset record
 * @param {object} rule     MonitoringRule record including `conditions` array
 * @returns {{triggered:boolean, violatedFields:string[]}}
 */
export function evaluateRule(asset, rule) {
  const age = daysSince(asset.CreationDate);

  if (age <= rule.ageDaysThreshold) {
    return { triggered: false, violatedFields: [] };
  }

  const conditions   = rule.conditions || [];
  const fieldConds   = conditions.filter(c => c.conditionType !== 'CONTAINS_KEYWORD');
  const keywordConds = conditions.filter(c => c.conditionType === 'CONTAINS_KEYWORD');

  // IS_EMPTY / IS_NOT_EMPTY: ALL must match (AND)
  const fieldViolated = fieldConds.filter(c => evaluateFieldCondition(asset, c));
  const fieldsMet     = fieldConds.length === 0 || fieldViolated.length === fieldConds.length;

  // CONTAINS_KEYWORD: ANY must match (OR)
  const keywordViolated = keywordConds.filter(c => evaluateFieldCondition(asset, c));
  const keywordsMet     = keywordConds.length === 0 || keywordViolated.length > 0;

  const allViolated = [...fieldViolated, ...keywordViolated].map(
    c => `${c.fieldName} ${c.conditionType}${c.keywordValue ? ` '${c.keywordValue}'` : ''}`
  );

  const triggered = fieldsMet && keywordsMet && allViolated.length > 0;
  return { triggered, violatedFields: allViolated };
}

/**
 * Evaluates a single asset record against all provided active rules.
 *
 * @param {object}   asset   S/4HANA asset record
 * @param {object[]} rules   Array of MonitoringRule records (with `.conditions`)
 * @returns {Array<{rule: object, violatedFields: string[]}>}
 */
export function evaluateAsset(asset, rules) {
  const violations = [];
  for (const rule of rules) {
    if (!rule.isActive) continue;
    const result = evaluateRule(asset, rule);
    if (result.triggered) {
      violations.push({ rule, violatedFields: result.violatedFields });
    }
  }
  return violations;
}

/**
 * Orchestrates a full scan run.
 *
 * @param {string}  scanRunId   UUID of the ScanRun record to update
 * @param {object}  db          CDS database service
 * @param {object}  s4          S4 integration module (injectable for testing)
 * @returns {Promise<{evaluated:number, flagged:number}>}
 */
export async function runScan(scanRunId, db, s4) {
  const { MonitoringRules, SensitiveFieldConditions, FlaggedAssets, ScanRuns } = cds.entities('assetmonitor');

  // Load all active rules with their conditions
  const rules = await db.run(
    SELECT.from(MonitoringRules).where({ isActive: true })
  );

  for (const rule of rules) {
    rule.conditions = await db.run(
      SELECT.from(SensitiveFieldConditions).where({ rule_ID: rule.ID })
    );
  }

  // Stale PENDING cleanup: delete PENDING records whose rule is now deactivated.
  // Runs on every scan so the dashboard always reflects current rule configuration.
  // Only PENDING is touched — records already in human review (RECOMMENDED/APPROVED/EXECUTED) are left alone.
  const inactiveRules = await db.run(
    SELECT.from(MonitoringRules).where({ isActive: false }).columns('ID')
  );
  if (inactiveRules.length > 0) {
    const inactiveIds = inactiveRules.map(r => r.ID);
    const deleted = await db.run(
      DELETE.from(FlaggedAssets).where({
        reviewStatus: 'PENDING',
        rule_ID: { in: inactiveIds },
      })
    );
    cds.log('rule-engine').info('Stale cleanup: removed %d PENDING records for %d deactivated rules', deleted, inactiveIds.length);
  }

  if (rules.length === 0) {
    cds.log('rule-engine').info('No active rules found — scan will produce no results');
    await db.run(UPDATE(ScanRuns, scanRunId).with({ status: 'COMPLETED', completedAt: new Date(), totalRecordsEvaluated: 0, totalRecordsFlagged: 0 }));
    return { evaluated: 0, flagged: 0 };
  }

  // Fetch assets from S/4HANA (or mock)
  const assets = await s4.fetchFixedAssets();

  // Diagnostic: log AssetLifecycleStatus distribution to understand post-block/retire values
  const statusCounts = {};
  for (const a of assets) {
    const s = a.AssetLifecycleStatus || '(empty)';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  cds.log('rule-engine').info('AssetLifecycleStatus distribution: %j', statusCounts);

  // ── Phase 1: evaluate every asset, collect the current violating set ────────
  // Blocked assets are NOT skipped — they are evaluated like any other and, if
  // they still violate a rule, flagged with isAlreadyBlocked = true.
  const currentKeys = new Set();
  const candidates  = [];   // { asset, rule, violatedFields, age, isBlocked }
  let blockedFlaggedCount = 0;

  for (const asset of assets) {
    const isBlocked  = !!asset.AccountIsBlockedForPosting;
    const violations = evaluateAsset(asset, rules);
    const age        = daysSince(asset.CreationDate);

    for (const { rule, violatedFields } of violations) {
      const key = `${asset.CompanyCode}|${asset.MasterFixedAsset}|${asset.FixedAsset}`;
      currentKeys.add(key);
      candidates.push({ asset, rule, violatedFields, age, isBlocked });
      if (isBlocked) blockedFlaggedCount++;
    }
  }

  // ── Phase 2: reconcile — remove stale PENDING rows ──────────────────────────
  // A PENDING row whose asset no longer appears in the current scan (deleted in
  // S/4, or no longer violating any rule) is dropped, so the dashboard always
  // reflects current S/4 reality. Rows already in human review are left alone.
  const pending = await db.run(
    SELECT.from(FlaggedAssets).where({ reviewStatus: 'PENDING' })
      .columns('ID', 'companyCode', 'masterFixedAsset', 'fixedAsset')
  );
  const staleIds = pending
    .filter(r => !currentKeys.has(`${r.companyCode}|${r.masterFixedAsset}|${r.fixedAsset}`))
    .map(r => r.ID);
  if (staleIds.length > 0) {
    await db.run(DELETE.from(FlaggedAssets).where({ ID: { in: staleIds } }));
    cds.log('rule-engine').info('Reconcile: removed %d stale PENDING rows no longer in S/4/rules', staleIds.length);
  }

  // ── Phase 2b: collapse duplicate rows so each asset key has exactly one row ──
  // Enforces single asset identity: keep the most-progressed row (no human
  // decision is lost), delete the extras. Idempotent — no-op when there are none.
  // FlaggedAssets is cuid-only (no timestamps), so the keeper is chosen by workflow rank.
  const allRows = await db.run(
    SELECT.from(FlaggedAssets).columns('ID', 'companyCode', 'masterFixedAsset', 'fixedAsset', 'reviewStatus')
  );
  const RANK = { EXECUTED: 6, FAILED: 5, APPROVED: 4, RECOMMENDED_BLOCK: 3, RECOMMENDED_DELETE: 3, RECOMMENDED_KEEP: 3, REJECTED: 2, PENDING: 1 };
  const groups = new Map();
  for (const r of allRows) {
    const k = `${r.companyCode}|${r.masterFixedAsset}|${r.fixedAsset}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const dupIds = [];
  for (const rows of groups.values()) {
    if (rows.length <= 1) continue;
    rows.sort((a, b) => (RANK[b.reviewStatus] || 0) - (RANK[a.reviewStatus] || 0));
    dupIds.push(...rows.slice(1).map(r => r.ID)); // keep rows[0] (highest rank), drop the rest
  }
  if (dupIds.length > 0) {
    await db.run(DELETE.from(FlaggedAssets).where({ ID: { in: dupIds } }));
    cds.log('rule-engine').info('Dedup collapse: removed %d duplicate row(s)', dupIds.length);
  }

  // ── Phase 2c: re-open executed blocks that S/4 now confirms as blocked ──────
  // Once a BLOCK we executed is reflected in S/4 (AccountIsBlockedForPosting), the
  // row is moved out of History and back into the Blocked Assets worklist as a
  // clean PENDING+isAlreadyBlocked item, so a further Retire/Delete can be taken
  // through the normal governed flow. The block itself stays in the Audit Log.
  // Idempotent: after re-open the row is PENDING (not EXECUTED), so it won't match again.
  const blockedInS4 = new Set(
    assets.filter(a => a.AccountIsBlockedForPosting)
          .map(a => `${a.CompanyCode}|${a.MasterFixedAsset}|${a.FixedAsset}`)
  );
  const executedBlocks = await db.run(
    SELECT.from(FlaggedAssets)
      .where({ reviewStatus: 'EXECUTED', recommendedAction: 'RECOMMENDED_BLOCK' })
      .columns('ID', 'companyCode', 'masterFixedAsset', 'fixedAsset')
  );
  const reopenIds = executedBlocks
    .filter(r => blockedInS4.has(`${r.companyCode}|${r.masterFixedAsset}|${r.fixedAsset}`))
    .map(r => r.ID);
  if (reopenIds.length > 0) {
    await db.run(
      UPDATE(FlaggedAssets).where({ ID: { in: reopenIds } }).with({
        reviewStatus:         'PENDING',
        isAlreadyBlocked:     true,
        recommendedAction:    null,
        reviewedBy:           null,
        reviewedAt:           null,
        reviewComment:        null,
        approvedBy:           null,
        approvedAt:           null,
        writeBackStatus:      null,
        writeBackTimestamp:   null,
        writeBackSapResponse: null,
      })
    );
    cds.log('rule-engine').info('Block confirmed: re-opened %d executed-block asset(s) into Blocked worklist', reopenIds.length);
  }

  // ── Phase 3: insert new candidates, skipping any asset that already has a row ──
  // Dedup against ALL existing rows (any status) — enforces one row per asset key.
  // This closes the former FAILED/REJECTED gap that let scans breed duplicate PENDING rows.
  const existingFlags = await db.run(
    SELECT.from(FlaggedAssets)
      .columns('companyCode', 'masterFixedAsset', 'fixedAsset')
  );
  const activeSet = new Set(existingFlags.map(r => `${r.companyCode}|${r.masterFixedAsset}|${r.fixedAsset}`));
  cds.log('rule-engine').info('Deduplication: %d assets already have a row — will skip', activeSet.size);

  let flaggedCount = 0;

  for (const { asset, rule, violatedFields, age, isBlocked } of candidates) {
    const assetKey = `${asset.CompanyCode}|${asset.MasterFixedAsset}|${asset.FixedAsset}`;
    if (activeSet.has(assetKey)) continue;
    activeSet.add(assetKey); // guard against the same asset violating multiple rules in one scan

    flaggedCount++;

    // AI recommendation — runs in parallel with DB insert, returns null in mock mode
    const aiRec = await aiService.getAssetRecommendation(
      { ...asset, daysSince: age },
      violatedFields
    );

    await db.run(
      INSERT.into(FlaggedAssets).entries({
        ID: cds.utils.uuid(),
        scanRun_ID: scanRunId,
        rule_ID: rule.ID,
        companyCode: asset.CompanyCode,
        masterFixedAsset: asset.MasterFixedAsset,
        fixedAsset: asset.FixedAsset,
        assetDescription: asset.FixedAssetDescription,
        assetClass: asset.AssetClass,
        creationDate: asset.CreationDate,
        acquisitionValueDate: asset.AcquisitionValueDate || null,
        assetCapitalizationDate: asset.AssetCapitalizationDate || null,
        assetDeactivationDate: asset.AssetDeactivationDate || null,
        daysSinceCreation: age,
        isAlreadyBlocked: isBlocked,
        triggeringFieldsSummary: violatedFields.join('; '),
        reviewStatus: 'PENDING',
        aiRecommendedAction: aiRec?.action     || null,
        aiReasoningSummary:  aiRec?.reasoning  || null,
        aiConfidenceScore:   aiRec?.confidence != null ? aiRec.confidence : null,
      })
    );
  }

  await db.run(
    UPDATE(ScanRuns, scanRunId).with({
      status: 'COMPLETED',
      completedAt: new Date(),
      totalRecordsEvaluated: assets.length,
      totalRecordsFlagged: flaggedCount,
    })
  );

  cds.log('rule-engine').info('Scan completed — scan_id=%s, evaluated=%d, flagged=%d (blocked=%d), staleRemoved=%d', scanRunId, assets.length, flaggedCount, blockedFlaggedCount, staleIds.length);

  return { evaluated: assets.length, flagged: flaggedCount };
}
