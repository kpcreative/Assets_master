import * as s4Integration from './s4-integration.js';
import { runScan }         from './rule-engine.js';
import * as emailService   from './email-service.js';
import * as aiWriter       from './ai-email-writer.js';

const VALID_ACTIONS = ['RECOMMENDED_BLOCK', 'RECOMMENDED_DELETE', 'RECOMMENDED_KEEP'];
const REC_STATUSES  = ['RECOMMENDED_BLOCK', 'RECOMMENDED_DELETE', 'RECOMMENDED_KEEP'];

// Permanent bootstrap admin(s). Always treated as admin, independent of the
// AdminUsers table, so the first owner can never be locked out even if the DB
// seed fails to run. These entries cannot be removed via the UI.
const BOOTSTRAP_ADMINS = ['kartik.pandey@sap.com'];

export default class MonitoringService extends cds.ApplicationService {

  async init() {
    const { MonitoringRules, ScanRuns, FlaggedAssets, AuditLog, AlertRecipients } = this.entities;
    // AdminUsers lives in the db model only (not projected into the service) — reference by name
    const AdminUsers = 'assetmonitor.AdminUsers';

    // Only admins may add/remove/change alert recipients (reads stay open)
    this.before(['CREATE', 'UPDATE', 'DELETE'], AlertRecipients, async (req) => {
      if (!(await this._isAdmin(req))) return req.reject(403, 'Admin privilege required');
    });

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

      // Non-KEEP recommendations require admin approval — batch them and email admins.
      if (action !== 'RECOMMENDED_KEEP') {
        await this._createBatchAndNotify([flaggedAssetId], user, req);
      }

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
      const updatedIds = [];
      for (const id of flaggedAssetIds) {
        const n = await UPDATE(FlaggedAssets)
          .where({ ID: id, reviewStatus: 'PENDING' })
          .with({ reviewStatus: action, recommendedAction: action, reviewedBy: user, reviewedAt: new Date(), reviewComment: comment || null });
        if (n) { updated++; updatedIds.push(id); }
      }

      await this._writeAudit({
        eventType: 'ASSET_REVIEWED', performedBy: user, entityType: 'FlaggedAsset', entityId: flaggedAssetIds[0],
        details: `Bulk recommendation: ${action} applied to ${updated} of ${flaggedAssetIds.length} assets`,
      });

      // Non-KEEP recommendations require admin approval — batch them and email admins.
      if (action !== 'RECOMMENDED_KEEP' && updatedIds.length > 0) {
        await this._createBatchAndNotify(updatedIds, user, req);
      }

      return { updated };
    });

    // -----------------------------------------------------------------------
    // approveAction — Finance Manager approves a single recommendation
    // -----------------------------------------------------------------------
    this.on('approveAction', async (req) => {
      if (!(await this._isAdmin(req))) return req.reject(403, 'Admin privilege required');
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
      if (!(await this._isAdmin(req))) return req.reject(403, 'Admin privilege required');
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
      if (!(await this._isAdmin(req))) return req.reject(403, 'Admin privilege required');
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
      if (!(await this._isAdmin(req))) return req.reject(403, 'Admin privilege required');
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
        const outcome = await this._executeAsset(asset, user);
        if (outcome.ok) executed++;
        else { failed++; errors.push(outcome.error); }
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
      if (!(await this._isAdmin(req))) return req.reject(403, 'Admin privilege required');
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

    // -----------------------------------------------------------------------
    // currentUser — returns authenticated user info for the header
    // -----------------------------------------------------------------------
    this.on('currentUser', async (req) => {
      const u = req.user || {};
      const id    = u.id    || 'anonymous';
      const email = u.email || '';
      const name  = u.name  || u.email || u.id || 'SAP User';

      const parts    = name.split(/[\s@]+/).filter(Boolean);
      const initials = parts.length >= 2
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : name.slice(0, 2).toUpperCase();

      const isAdmin = await this._isAdmin(req);

      return { id, name, email, initials, isAdmin };
    });

    // -----------------------------------------------------------------------
    // listAdmins / addAdmin / removeAdmin — manage the admin allowlist
    // -----------------------------------------------------------------------
    this.on('listAdmins', async (req) => {
      if (!(await this._isAdmin(req))) return req.reject(403, 'Admin privilege required');
      const rows = await SELECT.from(AdminUsers).orderBy({ addedAt: 'asc' });
      const present = new Set(rows.map(r => r.email));
      // Surface permanent bootstrap admins that aren't (yet) in the table
      const bootstrap = BOOTSTRAP_ADMINS
        .filter(e => !present.has(e))
        .map(e => ({ email: e, addedBy: 'system (permanent)', addedAt: null }));
      return [...bootstrap, ...rows];
    });

    this.on('addAdmin', async (req) => {
      if (!(await this._isAdmin(req))) return req.reject(403, 'Admin privilege required');
      const email = (req.data.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) return req.reject(400, 'A valid email address is required');

      const exists = await SELECT.one.from(AdminUsers).where({ email });
      if (!exists) {
        await INSERT.into(AdminUsers).entries({ email, addedBy: this._adminEmails(req)[0] || 'system', addedAt: new Date() });
        await this._writeAudit({ eventType: 'ADMIN_ADDED', performedBy: this._adminEmails(req)[0] || 'system', entityType: 'AdminUser', entityId: email, details: `Admin added: ${email}` });
      }
      return { success: true };
    });

    this.on('removeAdmin', async (req) => {
      if (!(await this._isAdmin(req))) return req.reject(403, 'Admin privilege required');
      const email = (req.data.email || '').trim().toLowerCase();

      if (BOOTSTRAP_ADMINS.includes(email)) return req.reject(400, 'This is a permanent admin and cannot be removed');

      const all = await SELECT.from(AdminUsers).columns('email');
      if (all.length <= 1) return req.reject(400, 'Cannot remove the last remaining admin');
      if (!all.some(a => a.email === email)) return req.reject(404, 'Admin not found');

      await DELETE.from(AdminUsers).where({ email });
      await this._writeAudit({ eventType: 'ADMIN_REMOVED', performedBy: this._adminEmails(req)[0] || 'system', entityType: 'AdminUser', entityId: email, details: `Admin removed: ${email}` });
      return { success: true };
    });

    // -----------------------------------------------------------------------
    // aiDiagnoseError — in-app AI diagnosis of a failed asset's S/4 write-back
    // -----------------------------------------------------------------------
    this.on('aiDiagnoseError', async (req) => {
      if (!(await this._isAdmin(req))) return req.reject(403, 'Admin privilege required');
      const { flaggedAssetId } = req.data;

      const asset = await SELECT.one.from(FlaggedAssets)
        .where({ ID: flaggedAssetId })
        .columns('companyCode', 'masterFixedAsset', 'fixedAsset', 'writeBackSapResponse');
      if (!asset) return req.reject(404, 'Flagged asset not found');

      const text = await aiWriter.diagnoseError({
        bukrs:    asset.companyCode,
        anln1:    asset.masterFixedAsset,
        anln2:    asset.fixedAsset || '0',
        messages: asset.writeBackSapResponse || 'No error detail recorded',
      });
      return { text };
    });

    // -----------------------------------------------------------------------
    // emailDecide — approve/cancel link clicked from the approval email.
    // GET (OData function) → routed through the approuter's xsuaa route, so
    // req.user is the acting (SSO-authenticated) admin. Returns an HTML page.
    // -----------------------------------------------------------------------
    this.on('emailDecide', async (req) => {
      const res = req.http?.res;
      const batchId  = req.data.batch;
      const decision = String(req.data.decision || '').toLowerCase(); // 'approve' | 'cancel'

      if (!(await this._isAdmin(req))) return this._htmlPage(res, 403, 'Access denied', '<p>You are not authorized to act on this request.</p>');
      if (!batchId || !['approve', 'cancel'].includes(decision)) {
        return this._htmlPage(res, 400, 'Invalid link', '<p>This approval link is malformed.</p>');
      }

      const admin = this._adminEmails(req)[0] || req.user?.id || 'admin';
      const ApprovalBatches = 'assetmonitor.ApprovalBatches';

      const batch = await SELECT.one.from(ApprovalBatches).where({ batchId });
      if (!batch) return this._htmlPage(res, 404, 'Not found', '<p>This approval request no longer exists.</p>');

      // Atomic single-winner claim.
      const claimed = await UPDATE(ApprovalBatches)
        .where({ batchId, decision: null })
        .with({ decision: decision === 'approve' ? 'APPROVED' : 'CANCELLED', decidedBy: admin, decidedAt: new Date() });

      if (!claimed) {
        const fresh = await SELECT.one.from(ApprovalBatches).where({ batchId });
        const verb  = fresh?.decision === 'CANCELLED' ? 'cancelled' : 'approved';
        return this._htmlPage(res, 200, 'Already decided',
          `<p>This batch was already <strong>${aiWriter.escapeHtml(verb)}</strong> by <strong>${aiWriter.escapeHtml(fresh?.decidedBy || 'another admin')}</strong>. No further action is needed.</p>`);
      }

      const assets = await SELECT.from(FlaggedAssets)
        .where({ submissionBatch: batchId })
        .columns('ID', 'reviewStatus', 'companyCode', 'masterFixedAsset', 'fixedAsset', 'assetDescription', 'recommendedAction');

      if (decision === 'cancel') {
        for (const a of assets) {
          if (REC_STATUSES.includes(a.reviewStatus)) {
            await UPDATE(FlaggedAssets, a.ID).with({ reviewStatus: 'REJECTED', reviewComment: `Cancelled via email by ${admin}` });
            await this._writeAudit({ eventType: 'ACTION_REJECTED', performedBy: admin, entityType: 'FlaggedAsset', entityId: a.ID, details: `Cancelled via email` });
          }
        }
        await UPDATE(ApprovalBatches).where({ batchId }).with({ resultSummary: `Cancelled by ${admin}` });
        await this._notifyOtherAdmins(batch, admin, 'CANCELLED', req).catch(() => {});
        await this._notifyRequester(batch, admin, 'CANCELLED', 'Your recommendation was cancelled.', req).catch(() => {});
        return this._htmlPage(res, 200, 'Cancelled',
          `<p>You have <strong>cancelled</strong> ${assets.length} recommendation(s) from <strong>${aiWriter.escapeHtml(batch.requestedBy)}</strong>. The requester and other admins have been notified.</p>`);
      }

      // approve → mark APPROVED + execute S/4 write-back for each asset
      let executed = 0, failed = 0;
      const failures = [];
      for (const a of assets) {
        if (!REC_STATUSES.includes(a.reviewStatus)) continue;
        await UPDATE(FlaggedAssets, a.ID).with({ reviewStatus: 'APPROVED', approvedBy: admin, approvedAt: new Date() });
        await this._writeAudit({ eventType: 'ACTION_APPROVED', performedBy: admin, entityType: 'FlaggedAsset', entityId: a.ID, details: `Approved via email` });

        const fresh = { ...a, reviewStatus: 'APPROVED' };
        const outcome = await this._executeAsset(fresh, admin);
        if (outcome.ok) executed++;
        else { failed++; failures.push(outcome.error); }
      }

      const summary = `Approved by ${admin}: ${executed} executed, ${failed} failed`;
      await UPDATE(ApprovalBatches).where({ batchId }).with({ resultSummary: summary });
      await this._notifyOtherAdmins(batch, admin, 'APPROVED', req).catch(() => {});

      if (failed === 0) {
        await this._notifyRequester(batch, admin, 'APPROVED',
          `Your recommendation was approved and executed in S/4HANA (${executed} asset(s)).`, req).catch(() => {});
      } else {
        // Error path: leave failed assets FAILED; email admins with the two action buttons.
        // The requester is NOT auto-notified — an admin decides via "Notify requester & reject".
        for (const f of failures) {
          await this._notifyAdminsError(batch, admin, f, req).catch(() => {});
        }
      }

      const okLine = `<p>You <strong>approved</strong> the batch from <strong>${aiWriter.escapeHtml(batch.requestedBy)}</strong>. <strong>${executed}</strong> action(s) executed in S/4HANA.</p>`;
      const failLine = failed > 0
        ? `<p style="color:#b91c1c;"><strong>${failed}</strong> action(s) failed. Administrators have been emailed the error details with options to diagnose or reject.</p>`
        : `<p>The requester and other administrators have been notified.</p>`;
      return this._htmlPage(res, 200, 'Approved', okLine + failLine);
    });

    // -----------------------------------------------------------------------
    // emailAiDiagnose — "Send to AI" button on an error email. Admin-guarded.
    // -----------------------------------------------------------------------
    this.on('emailAiDiagnose', async (req) => {
      const res = req.http?.res;
      const { batch: batchId, asset: assetId } = req.data;

      if (!(await this._isAdmin(req))) return this._htmlPage(res, 403, 'Access denied', '<p>You are not authorized.</p>');

      const asset = await SELECT.one.from(FlaggedAssets)
        .where({ ID: assetId })
        .columns('companyCode', 'masterFixedAsset', 'fixedAsset', 'writeBackSapResponse');
      if (!asset) return this._htmlPage(res, 404, 'Not found', '<p>Asset not found.</p>');

      const text = await aiWriter.diagnoseError({
        bukrs:    asset.companyCode,
        anln1:    asset.masterFixedAsset,
        anln2:    asset.fixedAsset || '0',
        messages: asset.writeBackSapResponse || 'No error detail recorded',
      });

      const bodyHtml = aiWriter.escapeHtml(text).replace(/\n/g, '<br>');
      return this._htmlPage(res, 200, 'AI diagnosis',
        `<p style="margin:0 0 12px;color:#64748b;">Asset ${aiWriter.escapeHtml(asset.companyCode)}/${aiWriter.escapeHtml(asset.masterFixedAsset)}/${aiWriter.escapeHtml(asset.fixedAsset || '0')}</p>` +
        `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;line-height:1.5;">${bodyHtml}</div>`);
    });

    // -----------------------------------------------------------------------
    // emailRejectNotify — "Notify requester & reject" button on an error email.
    // Marks the failed asset REJECTED and emails the requester. Idempotent.
    // -----------------------------------------------------------------------
    this.on('emailRejectNotify', async (req) => {
      const res = req.http?.res;
      const { batch: batchId, asset: assetId } = req.data;

      if (!(await this._isAdmin(req))) return this._htmlPage(res, 403, 'Access denied', '<p>You are not authorized.</p>');

      const admin = this._adminEmails(req)[0] || req.user?.id || 'admin';
      const ApprovalBatches = 'assetmonitor.ApprovalBatches';

      const asset = await SELECT.one.from(FlaggedAssets)
        .where({ ID: assetId })
        .columns('ID', 'reviewStatus', 'companyCode', 'masterFixedAsset', 'fixedAsset', 'writeBackSapResponse');
      if (!asset) return this._htmlPage(res, 404, 'Not found', '<p>Asset not found.</p>');

      if (asset.reviewStatus === 'REJECTED') {
        return this._htmlPage(res, 200, 'Already sent', '<p>The requester has already been notified and this recommendation was rejected.</p>');
      }

      await UPDATE(FlaggedAssets, asset.ID).with({
        reviewStatus:  'REJECTED',
        reviewComment: `Rejected via email by ${admin} after S/4HANA error`,
      });
      await this._writeAudit({ eventType: 'ACTION_REJECTED', performedBy: admin, entityType: 'FlaggedAsset', entityId: asset.ID, details: `Rejected via email after write-back error` });

      const batch = await SELECT.one.from(ApprovalBatches).where({ batchId });
      await this._notifyRequesterError(batch, {
        bukrs:    asset.companyCode,
        anln1:    asset.masterFixedAsset,
        anln2:    asset.fixedAsset || '0',
        messages: asset.writeBackSapResponse || 'Unknown error',
      }, req).catch(() => {});

      return this._htmlPage(res, 200, 'Requester notified',
        `<p>Asset <strong>${aiWriter.escapeHtml(asset.companyCode)}/${aiWriter.escapeHtml(asset.masterFixedAsset)}</strong> was rejected and the requester has been notified of the error.</p>`);
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

      // Seed the initial admin (idempotent) — works in both sqlite (dev) and HANA (prod)
      try {
        const { AdminUsers } = cds.entities('assetmonitor');
        const db = await cds.connect.to('db');
        const seed = 'kartik.pandey@sap.com';
        const exists = await db.run(SELECT.one.from(AdminUsers).where({ email: seed }));
        if (!exists) {
          await db.run(INSERT.into(AdminUsers).entries({ email: seed, addedBy: 'system-seed', addedAt: new Date() }));
          cds.log('monitoring-service').info('Seeded initial admin: %s', seed);
        }
      } catch (e) {
        cds.log('monitoring-service').warn('Admin seed skipped: %s', e.message);
      }
    });

    return super.init();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Candidate login identifiers for the caller, lowercased. */
  _adminEmails(req) {
    return [req.user?.email, req.user?.id, req.user?.name]
      .filter(Boolean)
      .map(s => String(s).trim().toLowerCase());
  }

  /** True if the caller's email/id is in the AdminUsers allowlist.
   *  In dummy/mocked auth (local dev) everyone is admin so the full UI is testable. */
  async _isAdmin(req) {
    const authCfg = cds.env.requires?.auth;
    const kind = typeof authCfg === 'string' ? authCfg : authCfg?.kind;
    if (kind === 'dummy' || kind === 'mocked') return true;

    const candidates = this._adminEmails(req);
    if (!candidates.length) return false;

    // Permanent bootstrap owner — always admin, even if the DB seed never ran
    if (candidates.some(c => BOOTSTRAP_ADMINS.includes(c))) return true;

    const AdminUsers = 'assetmonitor.AdminUsers';
    const hit = await SELECT.one.from(AdminUsers).where({ email: { in: candidates } });
    return !!hit;
  }

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

  // -------------------------------------------------------------------------
  // Shared S/4 write-back for a single asset (used by executeApprovedActions
  // and the email approve path). Never throws — returns {ok, error?}.
  // Expects `asset` with reviewStatus already APPROVED.
  // -------------------------------------------------------------------------
  async _executeAsset(asset, user) {
    const { FlaggedAssets } = this.entities;
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
      return { ok: true };

    } catch (err) {
      await UPDATE(FlaggedAssets, asset.ID).with({
        reviewStatus: 'FAILED',
        writeBackStatus: 'FAILED',
        writeBackTimestamp: new Date(),
        writeBackSapResponse: err.messages || err.message,
      });

      await this._writeAudit({ eventType: 'WRITEBACK_FAILED', performedBy: user, entityType: 'FlaggedAsset', entityId: asset.ID, details: `Write-back failed: ${err.message}` });
      cds.log('monitoring-service').error('Write-back failed — asset_id=%s: %s', asset.ID, err.message);

      return {
        ok: false,
        error: {
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
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // Approval-batch + email helpers
  // -------------------------------------------------------------------------

  /** Union of BOOTSTRAP_ADMINS + AdminUsers emails, lowercased & unique. */
  async _adminEmailList() {
    const AdminUsers = 'assetmonitor.AdminUsers';
    let rows = [];
    try { rows = await SELECT.from(AdminUsers).columns('email'); } catch { /* table may be empty */ }
    const all = [...BOOTSTRAP_ADMINS, ...rows.map(r => r.email)]
      .filter(Boolean)
      .map(e => String(e).trim().toLowerCase());
    return [...new Set(all)];
  }

  /**
   * Resolve the approuter's public base URL for building email links.
   * APP_BASE_URL env → forwarded headers of the triggering request → localhost.
   * Caches the first non-localhost value it derives.
   */
  _baseUrl(req) {
    if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, '');
    if (this._cachedBaseUrl) return this._cachedBaseUrl;
    const h = req?.http?.req?.headers || {};
    const proto = h['x-forwarded-proto'] || 'https';
    const host  = h['x-forwarded-host']  || h.host;
    if (host) {
      const url = `${proto}://${host}`.replace(/\/+$/, '');
      this._cachedBaseUrl = url;
      return url;
    }
    return 'http://localhost:4004';
  }

  /** OData function invocation URL on the monitoring service. */
  _fnUrl(req, fn, params) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}='${encodeURIComponent(String(v))}'`)
      .join(',');
    return `${this._baseUrl(req)}/monitoring/${fn}(${qs})`;
  }

  /** Create an ApprovalBatches row, stamp assets, and email admins. Never throws. */
  async _createBatchAndNotify(assetIds, requestedBy, req) {
    const { FlaggedAssets } = this.entities;
    const ApprovalBatches = 'assetmonitor.ApprovalBatches';
    const batchId = cds.utils.uuid();
    try {
      await INSERT.into(ApprovalBatches).entries({
        batchId,
        requestedBy: requestedBy,
        createdAt:   new Date(),
        assetCount:  assetIds.length,
        decision:    null,
      });
      for (const id of assetIds) {
        await UPDATE(FlaggedAssets, id).with({ submissionBatch: batchId });
      }
      await this._sendApprovalEmail(batchId, req);
    } catch (err) {
      cds.log('monitoring-service').error('Approval email/batch failed (submission still saved): %s', err.message);
    }
  }

  /** Build asset rows as an HTML list for emails. */
  _assetLinesHtml(assets) {
    const label = (a) => a.recommendedAction === 'RECOMMENDED_DELETE' ? 'DELETE'
                       : a.recommendedAction === 'RECOMMENDED_KEEP'   ? 'KEEP' : 'BLOCK';
    return '<ul style="margin:0 0 12px;padding-left:18px;">' + assets.map(a =>
      `<li style="margin:0 0 4px;">${aiWriter.escapeHtml(a.companyCode)}/${aiWriter.escapeHtml(a.masterFixedAsset)}` +
      `${a.fixedAsset ? '/' + aiWriter.escapeHtml(a.fixedAsset) : ''} — ${aiWriter.escapeHtml(a.assetDescription || 'no description')} ` +
      `<strong>(${label(a)})</strong></li>`).join('') + '</ul>';
  }

  /** Compose + send the batched approval-request email to all admins. */
  async _sendApprovalEmail(batchId, req) {
    const { FlaggedAssets } = this.entities;
    const ApprovalBatches = 'assetmonitor.ApprovalBatches';

    const batch  = await SELECT.one.from(ApprovalBatches).where({ batchId });
    const assets = await SELECT.from(FlaggedAssets).where({ submissionBatch: batchId })
      .columns('companyCode', 'masterFixedAsset', 'fixedAsset', 'assetDescription', 'recommendedAction');
    const admins = await this._adminEmailList();
    if (admins.length === 0) return;

    const framed = await aiWriter.frameEmail('APPROVAL_REQUEST', {
      requestedBy: batch.requestedBy,
      count:       assets.length,
      assets,
    });

    const approveUrl = this._fnUrl(req, 'emailDecide', { batch: batchId, decision: 'approve' });
    const cancelUrl  = this._fnUrl(req, 'emailDecide', { batch: batchId, decision: 'cancel' });
    const buttons = emailService.button(approveUrl, 'Approve all', '#16a34a') +
                    emailService.button(cancelUrl,  'Cancel',      '#dc2626');

    const html = emailService.htmlShell(framed.subject, framed.bodyHtml + this._assetLinesHtml(assets), buttons);
    await emailService.sendHtmlEmail({ to: admins, subject: framed.subject, html });
  }

  /** Email all admins EXCEPT the one who decided, that the batch was decided. */
  async _notifyOtherAdmins(batch, decidedBy, decision, req) {
    const admins = (await this._adminEmailList()).filter(e => e !== String(decidedBy).toLowerCase());
    if (admins.length === 0) return;
    const framed = await aiWriter.frameEmail('DECISION_NOTICE', {
      decidedBy, decision, requestedBy: batch.requestedBy, count: batch.assetCount,
    });
    const html = emailService.htmlShell(framed.subject, framed.bodyHtml);
    await emailService.sendHtmlEmail({ to: admins, subject: framed.subject, html });
  }

  /** Email the requester the outcome (approved+executed or cancelled). */
  async _notifyRequester(batch, decidedBy, decision, resultSummary, req) {
    if (!batch?.requestedBy) return;
    const kind = decision === 'CANCELLED' ? 'DECISION_NOTICE' : 'APPROVED_RESULT';
    const framed = await aiWriter.frameEmail(kind, {
      decidedBy, decision, requestedBy: batch.requestedBy, count: batch.assetCount, resultSummary,
    });
    const html = emailService.htmlShell(framed.subject, framed.bodyHtml);
    await emailService.sendHtmlEmail({ to: batch.requestedBy, subject: framed.subject, html });
  }

  /** Email the requester that their recommendation errored and was rejected. */
  async _notifyRequesterError(batch, errCtx, req) {
    if (!batch?.requestedBy) return;
    const framed = await aiWriter.frameEmail('REQUESTER_ERROR', {
      requestedBy: batch.requestedBy, ...errCtx,
    });
    const html = emailService.htmlShell(framed.subject, framed.bodyHtml);
    await emailService.sendHtmlEmail({ to: batch.requestedBy, subject: framed.subject, html });
  }

  /** Email all admins that a write-back failed, with Send-to-AI + Reject buttons. */
  async _notifyAdminsError(batch, decidedBy, errCtx, req) {
    const admins = await this._adminEmailList();
    if (admins.length === 0) return;
    const framed = await aiWriter.frameEmail('EXECUTION_ERROR', {
      decidedBy, requestedBy: batch.requestedBy, ...errCtx,
    });
    const aiUrl     = this._fnUrl(req, 'emailAiDiagnose',  { batch: batch.batchId, asset: errCtx.assetId });
    const rejectUrl = this._fnUrl(req, 'emailRejectNotify', { batch: batch.batchId, asset: errCtx.assetId });
    const buttons = emailService.button(aiUrl, 'Send to AI', '#2563eb') +
                    emailService.button(rejectUrl, 'Notify requester &amp; reject', '#dc2626');
    const html = emailService.htmlShell(framed.subject, framed.bodyHtml, buttons);
    await emailService.sendHtmlEmail({ to: admins, subject: framed.subject, html });
  }

  /** Write a branded HTML confirmation page to the HTTP response and end it. */
  _htmlPage(res, status, title, bodyHtml) {
    const html = emailService.htmlShell(title, bodyHtml);
    if (res) {
      res.status(status).set('Content-Type', 'text/html; charset=utf-8').send(html);
    }
    return html;
  }
}
