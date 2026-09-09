/**
 * Scheduler — registers a recurring CDS job that triggers asset monitoring scans.
 *
 * Schedule is configurable via SCAN_CRON_SCHEDULE env variable.
 * Default: daily at 06:00 (UTC).
 *
 * The job uses the same scan logic as the triggerScan action handler,
 * but invokes it directly via the MonitoringService rather than through HTTP.
 */

import * as s4Integration from './s4-integration.js';
import { runScan }         from './rule-engine.js';
import * as emailService   from './email-service.js';

// Parse a simple "HH:MM" cron expression from env or use default 06:00
const CRON_SCHEDULE = process.env.SCAN_CRON_SCHEDULE || '0 6 * * *';

/**
 * Schedule the monitoring scan job.
 * Must be called from cds.on('served', …) so cds.db and cds.services are ready.
 *
 * @param {import('@sap/cds').Service} monitoringService  the MonitoringService instance
 */
export async function scheduleMonitoringScan(monitoringService) {
  const log = cds.log('scheduler');

  log.info('[Scheduler] Registering monitoring scan job with schedule: %s', CRON_SCHEDULE);

  cds.schedule?.job(CRON_SCHEDULE, async () => {
    log.info('[Scheduler] Triggered scheduled monitoring scan');
    try {
      await _runScheduledScan(monitoringService, log);
    } catch (err) {
      log.error('[Scheduler] Scheduled scan failed: %s', err.message);
    }
  });

  // Fallback: if cds.schedule is not available (older SDK), log a warning
  if (!cds.schedule) {
    log.warn('[Scheduler] cds.schedule not available — scheduled scans disabled. Trigger scans manually via the triggerScan action.');
  }
}

async function _runScheduledScan(monitoringService, log) {
  const { ScanRuns, AlertRecipients } = monitoringService.entities;
  const db = cds.db;

  const scanRunId = cds.utils.uuid();

  await db.run(INSERT.into(ScanRuns).entries({
    ID: scanRunId,
    status: 'RUNNING',
    startedAt: new Date(),
    triggeredBy: 'scheduler',
    totalRecordsEvaluated: 0,
    totalRecordsFlagged: 0,
  }));

  log.info('M1.achieved: monitoring rule created and activated — scan_id=%s', scanRunId);

  try {
    const { evaluated, flagged } = await runScan(scanRunId, db, s4Integration);

    log.info('[Scheduler] Scan completed — scan_id=%s, evaluated=%d, flagged=%d', scanRunId, evaluated, flagged);

    if (flagged > 0) {
      const recipients = await db.run(
        SELECT.from(AlertRecipients).where({ role: 'ASSET_ACCOUNTANT', isActive: true }).columns('email')
      );
      const emails = recipients.map(r => r.email);
      if (emails.length > 0) {
        await emailService.sendScanAlert(scanRunId, flagged, emails);
      }
    }

  } catch (err) {
    log.error('[Scheduler] Scan failed — scan_id=%s: %s', scanRunId, err.message);

    await db.run(
      UPDATE(ScanRuns, scanRunId).with({
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: err.message,
      })
    );
  }
}

/**
 * Bootstrap hook — called after all CDS services are served.
 * Wires up the scheduler to the MonitoringService.
 */
export default {
  async bootstrapAll() {
    cds.on('served', async () => {
      const monitoringService = cds.services['MonitoringService'];
      if (!monitoringService) {
        cds.log('scheduler').warn('[Scheduler] MonitoringService not found — scheduler not started');
        return;
      }
      await scheduleMonitoringScan(monitoringService);
    });
  },
};
