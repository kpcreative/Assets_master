/**
 * Email notification service.
 *
 * When EMAIL_SERVICE_URL env var is not set (development / mock mode),
 * all emails are logged to the console instead of being sent.
 *
 * When EMAIL_SERVICE_URL is set, notifications are POSTed to the
 * SAP BTP Alert Notification Service REST API.
 */

function isMockMode() {
  return !process.env.EMAIL_SERVICE_URL;
}

/**
 * Send a scan summary alert to asset accountants.
 *
 * @param {string}   scanRunId        UUID of the completed scan run
 * @param {number}   newFlaggedCount  Number of newly flagged records
 * @param {string[]} recipientEmails  Array of recipient email addresses
 */
export async function sendScanAlert(scanRunId, newFlaggedCount, recipientEmails) {
  const subject = `Asset Monitoring: ${newFlaggedCount} new records flagged for review`;
  const body =
    `A monitoring scan (ID: ${scanRunId}) has completed.\n\n` +
    `${newFlaggedCount} asset record(s) have been flagged and are awaiting your review.\n\n` +
    `Please log into the Asset Master Data Monitor to review and submit recommendations.`;

  if (isMockMode()) {
    cds.log('email-service').info('[MOCK EMAIL] To: %s | Subject: %s\n%s', recipientEmails.join(', '), subject, body);
    return;
  }

  await _postAlert({ subject, body, recipients: recipientEmails, type: 'SCAN_COMPLETE' });
}

/**
 * Notify Finance Managers that recommendations are pending their approval.
 *
 * @param {{count:number, recommendedBy:string}} batchSummary
 * @param {string[]} managerEmails
 */
export async function sendApprovalRequest(batchSummary, managerEmails) {
  const subject = `Asset Monitoring: ${batchSummary.count} asset action(s) awaiting your approval`;
  const body =
    `${batchSummary.count} asset record(s) have been reviewed by ${batchSummary.recommendedBy} ` +
    `and are now awaiting Finance Manager approval.\n\n` +
    `Please log into the Asset Master Data Monitor to review and approve the recommended actions.`;

  if (isMockMode()) {
    cds.log('email-service').info('[MOCK EMAIL] To: %s | Subject: %s\n%s', managerEmails.join(', '), subject, body);
    return;
  }

  await _postAlert({ subject, body, recipients: managerEmails, type: 'APPROVAL_REQUIRED' });
}

/**
 * Internal helper: POST notification to SAP BTP Alert Notification Service.
 */
async function _postAlert({ subject, body, recipients, type }) {
  const url = process.env.EMAIL_SERVICE_URL;
  const payload = {
    eventType: type,
    eventTimestamp: Date.now(),
    severity: 'INFO',
    subject,
    body,
    recipients,
  };

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.EMAIL_SERVICE_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.EMAIL_SERVICE_TOKEN}`;
  }

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    cds.log('email-service').error('Alert Notification Service call failed: %s %s', res.status, text);
  }
}
