/**
 * Email notification service.
 *
 * Real email is sent via SMTP (nodemailer) when SMTP_HOST is configured.
 * Required env vars for live mode:
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE ("true"/"false"),
 *   SMTP_USER, SMTP_PASS, EMAIL_FROM
 *
 * When SMTP_HOST is not set (development / mock mode), all emails are logged
 * to the console instead of being sent.
 */

import nodemailer from 'nodemailer';

function isMockMode() {
  return !process.env.SMTP_HOST;
}

let _transport = null;
function transport() {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    auth: (process.env.SMTP_USER || process.env.SMTP_PASS)
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return _transport;
}

/**
 * Wrap body content + optional action buttons in a branded HTML shell.
 * Also usable for the browser confirmation pages returned by the email links.
 */
export function htmlShell(title, bodyHtml, buttonsHtml = '') {
  return `<!DOCTYPE html><html><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1e293b;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <div style="background:#1d2d3e;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;font-weight:700;font-size:16px;">
      Asset Master Data Monitor
    </div>
    <div style="background:#fff;padding:22px 20px;border:1px solid #e2e8f0;border-top:none;">
      <div style="font-size:17px;font-weight:600;margin:0 0 14px;color:#0f172a;">${title}</div>
      ${bodyHtml}
      ${buttonsHtml ? `<div style="margin-top:20px;">${buttonsHtml}</div>` : ''}
    </div>
    <div style="background:#f8fafc;padding:12px 20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;font-size:11.5px;color:#64748b;">
      This is an automated message from the SAP Asset Master Data Monitor.
    </div>
  </div></body></html>`;
}

/** Render a single call-to-action button (table-based for email client compatibility). */
export function button(href, label, color = '#2563eb') {
  return `<a href="${href}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:6px;margin:0 8px 8px 0;">${label}</a>`;
}

/**
 * Send an HTML email (or log it in mock mode).
 * @param {{to: string|string[], subject: string, html: string}} msg
 */
export async function sendHtmlEmail({ to, subject, html }) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (recipients.length === 0) return;

  if (isMockMode()) {
    cds.log('email-service').info('[MOCK EMAIL] To: %s | Subject: %s\n%s', recipients.join(', '), subject, html);
    return;
  }

  try {
    await transport().sendMail({
      from:    process.env.EMAIL_FROM || 'no-reply@asset-monitor.local',
      to:      recipients.join(', '),
      subject,
      html,
    });
  } catch (err) {
    cds.log('email-service').error('SMTP send failed: %s', err.message);
  }
}

/**
 * Send a scan summary alert to asset accountants.
 */
export async function sendScanAlert(scanRunId, newFlaggedCount, recipientEmails) {
  const subject = `Asset Monitoring: ${newFlaggedCount} new records flagged for review`;
  const body =
    `<p style="margin:0 0 12px;">A monitoring scan (ID: ${scanRunId}) has completed.</p>` +
    `<p style="margin:0 0 12px;"><strong>${newFlaggedCount}</strong> asset record(s) have been flagged and are awaiting your review.</p>` +
    `<p style="margin:0 0 12px;">Please log into the Asset Master Data Monitor to review and submit recommendations.</p>`;
  await sendHtmlEmail({ to: recipientEmails, subject, html: htmlShell('New records flagged', body) });
}
