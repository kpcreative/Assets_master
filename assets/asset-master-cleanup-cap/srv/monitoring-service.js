import * as s4Integration from './s4-integration.js';
import { runScan }         from './rule-engine.js';
import * as emailService   from './email-service.js';

const VALID_ACTIONS = ['RECOMMENDED_BLOCK', 'RECOMMENDED_DELETE', 'RECOMMENDED_KEEP'];

export default class MonitoringService extends cds.ApplicationService {

  async init() {
    const { MonitoringRules, ScanRuns, FlaggedAssets, AuditLog, AlertRecipients } = this.entities;

    // -----------------------------------------------------------------------
    // triggerScan — starts a full on-demand scan
    // -----------------------------------------------------------------------
    this.on('triggerScan', async (req) => {
      const scanRunId = cds.utils.uuid();
      const user = req.user?.id || 'anonymous';

      await INSERT.into(ScanRuns).entries({
        ID: scanRunId,
        status: 'RUNNING',
        startedAt: new Date(),
        triggeredBy: user,
        totalRecordsEvaluated: 0,
        totalRecordsFlagged: 0,
      });

      await this._writeAudit({ eventType: 'SCAN_STARTED', performedBy: user, entityType: 'ScanRun', entityId: scanRunId, details: 'On-demand scan initiated' });

      try {
        const { evaluated, flagged } = await runScan(scanRunId, cds.db, s4Integration);

        await this._writeAudit({
          eventType: 'SCAN_COMPLETED', performedBy: user, entityType: 'ScanRun', entityId: scanRunId,
          details: `Scan completed: ${evaluated} evaluated; ${flagged} flagged`,
        });

        if (flagged > 0) {
          const recipients = await SELECT.from(AlertRecipients).where({ role: 'ASSET_ACCOUNTANT', isActive: true }).columns('email');
          const emails = recipients.map(r => r.email);
          if (emails.length > 0) await emailService.sendScanAlert(scanRunId, flagged, emails);
        }
      } catch (err) {
        cds.log('monitoring-service').error('Scan failed: %s', err.message);
        await UPDATE(ScanRuns, scanRunId).with({ status: 'FAILED', completedAt: new Date(), errorMessage: err.message });
        await this._writeAudit({ eventType: 'SCAN_FAILED', performedBy: user, entityType: 'ScanRun', entityId: scanRunId, details: err.message });
        return req.reject(500, `Scan failed: ${err.message}`);
      }

      return { scanRunId };
    });

    // -----------------------------------------------------------------------
    // submitRecommendation — Asset Accountant sets a review status
    // -----------------------------------------------------------------------
    this.on('submitRecommendation', async (req) => {
      const { flaggedAssetId, action, comment } = req.data;
      const user = req.user?.id || 'anonymous';

      if (!VALID_ACTIONS.includes(action)) {
        return req.reject(400, `Invalid action "${action}". Must be one of: ${VALID_ACTIONS.join(', ')}`);
      }

      const n = await UPDATE(FlaggedAssets)
        .where({ ID: flaggedAssetId, reviewStatus: 'PENDING' })
        .with({ reviewStatus: action, recommendedAction: action, reviewedBy: user, reviewedAt: new Date(), reviewComment: comment || null });

      if (!n) return req.reject(404, `Flagged asset not found or not in PENDING status`);

      await this._writeAudit({ eventType: 'ASSET_REVIEWED', performedBy: user, entityType: 'FlaggedAsset', entityId: flaggedAssetId, details: `Status set to ${action}` });

      return { success: true };
    });

    // -----------------------------------------------------------------------
    // massSubmitRecommendation — bulk recommendation
    // -----------------------------------------------------------------------
    this.on('massSubmitRecommendation', async (req) => {
      const { flaggedAssetIds, action, comment } = req.data;
      const user = req.user?.id || 'anonymous';

      if (!VALID_ACTIONS.includes(action)) {
        return req.reject(400, `Invalid action "${action}".`);
      }
      if (!flaggedAssetIds || flaggedAssetIds.length === 0) return { updated: 0 };

      let updated = 0;
      for (const id of flaggedAssetIds) {
        const n = await UPDATE(FlaggedAssets)
          .where({ ID: id, reviewStatus: 'PENDING' })
          .with({ reviewStatus: action, recommendedAction: action, reviewedBy: user, reviewedAt: new Date(), reviewComment: comment || null });
        if (n) updated++;
      }

      await this._writeAudit({
        eventType: 'ASSET_REVIEWED', performedBy: user, entityType: 'FlaggedAsset', entityId: flaggedAssetIds[0],
        details: `Bulk recommendation: ${action} applied to ${updated} of ${flaggedAssetIds.length} assets`,
      });

      return { updated };
    });

    // -----------------------------------------------------------------------
    // approveAction — Finance Manager approves a single recommendation
    // -----------------------------------------------------------------------
    this.on('approveAction', async (req) => {
      const { flaggedAssetId } = req.data;
      const user = req.user?.id || 'anonymous';

      const n = await UPDATE(FlaggedAssets)
        .where({ ID: flaggedAssetId, reviewStatus: { in: ['RECOMMENDED_BLOCK', 'RECOMMENDED_DELETE', 'RECOMMENDED_KEEP'] } })
        .with({ reviewStatus: 'APPROVED', approvedBy: user, approvedAt: new Date() });

      if (!n) return req.reject(404, `Flagged asset not found or not in a recommendable status`);

      await this._writeAudit({ eventType: 'ACTION_APPROVED', performedBy: user, entityType: 'FlaggedAsset', entityId: flaggedAssetId, details: `Finance Manager approved action` });
      cds.log('monitoring-service').info('M5.achieved: approval complete — asset_id=%s, approved_by=%s', flaggedAssetId, user);

      return { success: true };
    });

    // -----------------------------------------------------------------------
    // rejectAction — Finance Manager rejects a recommendation
    // -----------------------------------------------------------------------
    this.on('rejectAction', async (req) => {
      const { flaggedAssetId, reason } = req.data;
      const user = req.user?.id || 'anonymous';

      const n = await UPDATE(FlaggedAssets)
        .where({ ID: flaggedAssetId, reviewStatus: { in: ['RECOMMENDED_BLOCK', 'RECOMMENDED_DELETE', 'RECOMMENDED_KEEP'] } })
        .with({ reviewStatus: 'REJECTED', reviewComment: reason || null });

      if (!n) return req.reject(404, `Flagged asset not found or not in a recommendable status`);

      await this._writeAudit({ eventType: 'ACTION_REJECTED', performedBy: user, entityType: 'FlaggedAsset', entityId: flaggedAssetId, details: `Rejected: ${reason || 'no reason given'}` });

      return { success: true };
    });

    // -----------------------------------------------------------------------
    // massApproveActions — Finance Manager bulk-approves
    // -----------------------------------------------------------------------
    this.on('massApproveActions', async (req) => {
      const { flaggedAssetIds } = req.data;
      const user = req.user?.id || 'anonymous';

      if (!flaggedAssetIds || flaggedAssetIds.length === 0) return { approved: 0 };

      let approved = 0;
      for (const id of flaggedAssetIds) {
        const n = await UPDATE(FlaggedAssets)
          .where({ ID: id, reviewStatus: { in: ['RECOMMENDED_BLOCK', 'RECOMMENDED_DELETE', 'RECOMMENDED_KEEP'] } })
          .with({ reviewStatus: 'APPROVED', approvedBy: user, approvedAt: new Date() });
        if (n) approved++;
      }

      await this._writeAudit({
        eventType: 'ACTION_APPROVED', performedBy: user, entityType: 'FlaggedAsset', entityId: flaggedAssetIds[0],
        details: `Bulk approval: ${approved} of ${flaggedAssetIds.length} approved`,
      });

      return { approved };
    });

    // -----------------------------------------------------------------------
    // executeApprovedActions — Triggers S/4HANA write-back
    // -----------------------------------------------------------------------
    this.on('executeApprovedActions', async (req) => {
      const { flaggedAssetIds } = req.data;
      const user = req.user?.id || 'anonymous';

      if (!flaggedAssetIds || flaggedAssetIds.length === 0) return { executed: 0, failed: 0 };

      const assets = await SELECT.from(FlaggedAssets)
        .where({ ID: { in: flaggedAssetIds }, reviewStatus: 'APPROVED' })
        .columns('ID', 'reviewStatus', 'companyCode', 'masterFixedAsset', 'fixedAsset', 'recommendedAction');

      let executed = 0;
      let failed = 0;
      const errors = [];

      for (const asset of assets) {
        try {
          const action = asset.recommendedAction || await this._getOriginalRecommendedAction(asset.ID);

          let result;
          if (action === 'RECOMMENDED_DELETE') {
            result = await s4Integration.deleteAssetViaSICF(asset.companyCode, asset.masterFixedAsset, asset.fixedAsset);
          } else if (action === 'RECOMMENDED_KEEP') {
            result = { success: true, response: 'No S/4HANA action required — KEEP decision recorded' };
          } else {
            result = await s4Integration.blockAssetViaSICF(asset.companyCode, asset.masterFixedAsset, asset.fixedAsset);
          }

          await UPDATE(FlaggedAssets, asset.ID).with({
            reviewStatus: 'EXECUTED',
            writeBackStatus: 'SUCCESS',
            writeBackTimestamp: new Date(),
            writeBackSapResponse: result.response,
          });

          await this._writeAudit({ eventType: 'WRITEBACK_SUCCESS', performedBy: user, entityType: 'FlaggedAsset', entityId: asset.ID, details: `Write-back succeeded` });
          cds.log('monitoring-service').info('M6.achieved: write-back complete — asset_id=%s, action=%s, status=SUCCESS', asset.ID, action);
          executed++;

        } catch (err) {
          await UPDATE(FlaggedAssets, asset.ID).with({
            reviewStatus: 'FAILED',
            writeBackStatus: 'FAILED',
            writeBackTimestamp: new Date(),
            writeBackSapResponse: err.message,
          });

          errors.push({
            assetId:          asset.ID,
            companyCode:      asset.companyCode,
            masterFixedAsset: asset.masterFixedAsset,
            fixedAsset:       asset.fixedAsset,
            bukrs:            err.bukrs          || asset.companyCode,
            anln1:            err.anln1          || asset.masterFixedAsset,
            anln2:            err.anln2          || asset.fixedAsset || '0',
            messages:         err.messages       || err.message,
            diagnosis:        err.diagnosis      || '',
            systemResponse:   err.systemResponse || '',
            procedure:        err.procedure      || '',
          });

          await this._writeAudit({ eventType: 'WRITEBACK_FAILED', performedBy: user, entityType: 'FlaggedAsset', entityId: asset.ID, details: `Write-back failed: ${err.message}` });
          cds.log('monitoring-service').error('Write-back failed — asset_id=%s: %s', asset.ID, err.message);
          failed++;
        }
      }

      return { executed, failed, errors };
    });

    // -----------------------------------------------------------------------
    // getLinkedPurchaseOrders — check if asset has linked POs (EKKN)
    // -----------------------------------------------------------------------
    this.on('getLinkedPurchaseOrders', async (req) => {
      const { masterFixedAsset } = req.data;
      try {
        const pos = await s4Integration.fetchLinkedPurchaseOrders(masterFixedAsset);
        return pos.map(po => ({ purchaseOrder: po }));
      } catch (err) {
        cds.log('monitoring-service').error('PO lookup failed for asset %s: %s', masterFixedAsset, err.message);
        return [];
      }
    });

    // -----------------------------------------------------------------------
    // massResetToPending — resets EXECUTED/FAILED assets back to PENDING
    // -----------------------------------------------------------------------
    this.on('massResetToPending', async (req) => {
      const { flaggedAssetIds } = req.data;
      const user = req.user?.id || 'anonymous';

      if (!flaggedAssetIds || flaggedAssetIds.length === 0) return { reset: 0 };

      let reset = 0;
      for (const id of flaggedAssetIds) {
        const n = await UPDATE(FlaggedAssets)
          .where({ ID: id, reviewStatus: { in: ['EXECUTED', 'FAILED', 'REJECTED'] } })
          .with({
            reviewStatus:         'PENDING',
            recommendedAction:    null,
            reviewedBy:           null,
            reviewedAt:           null,
            reviewComment:        null,
            approvedBy:           null,
            approvedAt:           null,
            writeBackStatus:      null,
            writeBackTimestamp:   null,
            writeBackSapResponse: null,
          });
        if (n) reset++;
      }

      await this._writeAudit({
        eventType:   'ASSET_RESET',
        performedBy: user,
        entityType:  'FlaggedAsset',
        entityId:    flaggedAssetIds[0],
        details:     `Reset to PENDING: ${reset} of ${flaggedAssetIds.length} assets`,
      });

      return { reset };
    });

    // One-time purge of demo seed data — idempotent (no-op if already gone)
    cds.on('served', async () => {
      try {
        const { FlaggedAssets, ScanRuns, AuditLog, AlertRecipients } = cds.entities('assetmonitor');
        const db = await cds.connect.to('db');
        const [fa, sr, al, ar] = await Promise.all([
          db.run(DELETE.from(FlaggedAssets).where({ ID: { like: '%1000000-0000-0000-0000-%' } })),
          db.run(DELETE.from(ScanRuns    ).where({ ID: { like: '%1000000-0000-0000-0000-%' } })),
          db.run(DELETE.from(AuditLog    ).where({ ID: { like: '%1000000-0000-0000-0000-%' } })),
          db.run(DELETE.from(AlertRecipients).where({ ID: { like: '%1000000-0000-0000-0000-%' } })),
        ]);
        cds.log('monitoring-service').info('Seed purge: FlaggedAssets=%d ScanRuns=%d AuditLog=%d AlertRecipients=%d', fa, sr, al, ar);
      } catch (e) {
        cds.log('monitoring-service').warn('Seed purge skipped: %s', e.message);
      }
    });

    return super.init();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  async _writeAudit({ eventType, performedBy, entityType, entityId, details }) {
    const { AuditLog } = this.entities;
    await INSERT.into(AuditLog).entries({
      ID: cds.utils.uuid(),
      eventType,
      performedBy,
      performedAt: new Date(),
      entityType,
      entityId,
      details,
    });
  }

  /**
   * Derives the original recommended action for an APPROVED asset by checking
   * the audit log for the last ASSET_REVIEWED event on this asset.
   * Falls back to RECOMMENDED_BLOCK if no entry found.
   */
  async _getOriginalRecommendedAction(flaggedAssetId) {
    const { AuditLog } = this.entities;
    const entry = await SELECT.one.from(AuditLog)
      .where({ entityId: flaggedAssetId, eventType: 'ASSET_REVIEWED' })
      .orderBy({ performedAt: 'desc' });

    if (entry?.details?.includes('RECOMMENDED_DELETE')) return 'RECOMMENDED_DELETE';
    if (entry?.details?.includes('RECOMMENDED_KEEP'))   return 'RECOMMENDED_KEEP';
    return 'RECOMMENDED_BLOCK'; // safe default
  }
}
