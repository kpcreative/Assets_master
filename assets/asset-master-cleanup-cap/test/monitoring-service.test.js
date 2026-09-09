/**
 * Integration tests for MonitoringService custom handlers.
 * Uses cds.test() to spin up the service in-process with SQLite.
 * Written as ESM (package.json has "type":"module").
 */

import cds from '@sap/cds';
cds.test(import.meta.dirname + '/..');

// ---------------------------------------------------------------------------
// Helpers — access entities lazily after server is ready
// ---------------------------------------------------------------------------
function getDb() { return cds.db; }
function getEntities() {
  const svc = cds.services['MonitoringService'];
  return svc ? svc.entities : {};
}

async function sendAction(action, data) {
  const svc = cds.services['MonitoringService'];
  return svc.send(action, data);
}

async function seedFlaggedAsset(overrides = {}) {
  const db = getDb();
  const { ScanRuns, MonitoringRules, FlaggedAssets } = getEntities();

  const ID = cds.utils.uuid();
  const scanRunId = cds.utils.uuid();
  const ruleId = cds.utils.uuid();

  await db.run(INSERT.into(ScanRuns).entries({
    ID: scanRunId, status: 'COMPLETED', startedAt: new Date(), completedAt: new Date(),
    triggeredBy: 'test', totalRecordsEvaluated: 1, totalRecordsFlagged: 1,
  }));

  await db.run(INSERT.into(MonitoringRules).entries({
    ID: ruleId, name: 'Test Rule', isActive: true, ageDaysThreshold: 90,
    targetTable: 'ANLA', createdBy: 'test', createdAt: new Date(), modifiedAt: new Date(),
  }));

  await db.run(INSERT.into(FlaggedAssets).entries({
    ID,
    scanRun_ID: scanRunId,
    rule_ID: ruleId,
    companyCode: '1000',
    masterFixedAsset: 'A00001',
    fixedAsset: '0000',
    assetDescription: 'Test Asset',
    assetClass: 'FURN',
    creationDate: '2022-01-01',
    daysSinceCreation: 200,
    triggeringFieldsSummary: 'ZUGDT IS_EMPTY',
    reviewStatus: 'PENDING',
    ...overrides,
  }));

  return { ID, scanRunId, ruleId };
}

// ---------------------------------------------------------------------------
// triggerScan
// ---------------------------------------------------------------------------
describe('triggerScan', () => {
  it('creates a ScanRun record and returns a scanRunId', async () => {
    const result = await sendAction('triggerScan', {});
    expect(result).toHaveProperty('scanRunId');
    expect(typeof result.scanRunId).toBe('string');

    const db = getDb();
    const { ScanRuns } = getEntities();
    const scanRun = await db.run(SELECT.one.from(ScanRuns).where({ ID: result.scanRunId }));
    expect(scanRun).toBeTruthy();
    expect(['COMPLETED', 'FAILED']).toContain(scanRun.status);
  });

  it('writes an audit log entry for the scan run', async () => {
    const result = await sendAction('triggerScan', {});
    const db = getDb();
    const { AuditLog } = getEntities();
    const logs = await db.run(SELECT.from(AuditLog).where({ entityId: result.scanRunId }));
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const eventTypes = logs.map(l => l.eventType);
    expect(eventTypes.some(e => ['SCAN_STARTED', 'SCAN_COMPLETED', 'SCAN_FAILED'].includes(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// submitRecommendation
// ---------------------------------------------------------------------------
describe('submitRecommendation', () => {
  it('sets reviewStatus to RECOMMENDED_DELETE for a PENDING asset', async () => {
    const { ID } = await seedFlaggedAsset({ reviewStatus: 'PENDING' });

    const result = await sendAction('submitRecommendation', {
      flaggedAssetId: ID,
      action: 'RECOMMENDED_DELETE',
      comment: 'Asset is no longer needed',
    });

    expect(result.success).toBe(true);

    const db = getDb();
    const { FlaggedAssets } = getEntities();
    const updated = await db.run(SELECT.one.from(FlaggedAssets).where({ ID }));
    expect(updated.reviewStatus).toBe('RECOMMENDED_DELETE');
  });

  it('rejects invalid action value with 400', async () => {
    const { ID } = await seedFlaggedAsset({ reviewStatus: 'PENDING' });

    await expect(
      sendAction('submitRecommendation', { flaggedAssetId: ID, action: 'INVALID', comment: '' })
    ).rejects.toMatchObject({ code: 400 });
  });

  it('rejects when asset is not in PENDING status with 404', async () => {
    const { ID } = await seedFlaggedAsset({ reviewStatus: 'APPROVED' });

    await expect(
      sendAction('submitRecommendation', { flaggedAssetId: ID, action: 'RECOMMENDED_DELETE', comment: '' })
    ).rejects.toMatchObject({ code: 404 });
  });

  it('writes an ASSET_REVIEWED audit log entry', async () => {
    const { ID } = await seedFlaggedAsset({ reviewStatus: 'PENDING' });
    await sendAction('submitRecommendation', { flaggedAssetId: ID, action: 'RECOMMENDED_BLOCK', comment: 'Block it' });

    const db = getDb();
    const { AuditLog } = getEntities();
    const log = await db.run(SELECT.one.from(AuditLog).where({ entityId: ID, eventType: 'ASSET_REVIEWED' }));
    expect(log).toBeTruthy();
    expect(log.details).toMatch(/RECOMMENDED_BLOCK/);
  });
});

// ---------------------------------------------------------------------------
// approveAction
// ---------------------------------------------------------------------------
describe('approveAction', () => {
  it('transitions RECOMMENDED_DELETE → APPROVED', async () => {
    const { ID } = await seedFlaggedAsset({ reviewStatus: 'RECOMMENDED_DELETE' });
    const result = await sendAction('approveAction', { flaggedAssetId: ID });
    expect(result.success).toBe(true);

    const db = getDb();
    const { FlaggedAssets } = getEntities();
    const updated = await db.run(SELECT.one.from(FlaggedAssets).where({ ID }));
    expect(updated.reviewStatus).toBe('APPROVED');
    expect(updated.approvedBy).toBeTruthy();
  });

  it('transitions RECOMMENDED_BLOCK → APPROVED', async () => {
    const { ID } = await seedFlaggedAsset({ reviewStatus: 'RECOMMENDED_BLOCK' });
    const result = await sendAction('approveAction', { flaggedAssetId: ID });
    expect(result.success).toBe(true);

    const db = getDb();
    const { FlaggedAssets } = getEntities();
    const updated = await db.run(SELECT.one.from(FlaggedAssets).where({ ID }));
    expect(updated.reviewStatus).toBe('APPROVED');
  });

  it('rejects when asset is in PENDING status with 404', async () => {
    const { ID } = await seedFlaggedAsset({ reviewStatus: 'PENDING' });

    await expect(
      sendAction('approveAction', { flaggedAssetId: ID })
    ).rejects.toMatchObject({ code: 404 });
  });
});

// ---------------------------------------------------------------------------
// executeApprovedActions
// ---------------------------------------------------------------------------
describe('executeApprovedActions', () => {
  it('marks asset as EXECUTED with writeBackStatus SUCCESS', async () => {
    const { ID } = await seedFlaggedAsset({ reviewStatus: 'APPROVED' });
    const db = getDb();
    const { AuditLog } = getEntities();

    // Seed audit log so handler knows original recommendation was RECOMMENDED_DELETE
    await db.run(INSERT.into(AuditLog).entries({
      ID: cds.utils.uuid(),
      eventType: 'ASSET_REVIEWED',
      performedBy: 'accountant@test.com',
      performedAt: new Date(),
      entityType: 'FlaggedAsset',
      entityId: ID,
      details: 'Status set to RECOMMENDED_DELETE',
    }));

    const result = await sendAction('executeApprovedActions', { flaggedAssetIds: [ID] });
    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);

    const { FlaggedAssets } = getEntities();
    const updated = await db.run(SELECT.one.from(FlaggedAssets).where({ ID }));
    expect(updated.reviewStatus).toBe('EXECUTED');
    expect(updated.writeBackStatus).toBe('SUCCESS');
  });

  it('returns 0 executed for empty flaggedAssetIds list', async () => {
    const result = await sendAction('executeApprovedActions', { flaggedAssetIds: [] });
    expect(result.executed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('skips PENDING assets — only APPROVED are executed', async () => {
    const { ID } = await seedFlaggedAsset({ reviewStatus: 'PENDING' });
    const result = await sendAction('executeApprovedActions', { flaggedAssetIds: [ID] });
    expect(result.executed).toBe(0);
    expect(result.failed).toBe(0);
  });
});
