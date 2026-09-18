using { assetmonitor as db } from '../db/schema';

service MonitoringService @(path: '/monitoring') {

  // -------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------
  entity MonitoringRules        as projection on db.MonitoringRules;
  entity SensitiveFieldConditions as projection on db.SensitiveFieldConditions;
  entity AlertRecipients        as projection on db.AlertRecipients;
  @readonly entity ScanRuns     as projection on db.ScanRuns;
  @readonly entity FlaggedAssets as projection on db.FlaggedAssets;
  @readonly entity AuditLog     as projection on db.AuditLog;

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Start an on-demand full scan */
  action triggerScan() returns { scanRunId: UUID };

  /** Asset Accountant sets a recommendation on a single asset */
  action submitRecommendation(
    flaggedAssetId : UUID,
    action         : String,
    comment        : String
  ) returns { success: Boolean };

  /** Asset Accountant sets recommendations in bulk */
  action massSubmitRecommendation(
    flaggedAssetIds : array of UUID,
    action          : String,
    comment         : String
  ) returns { updated: Integer };

  /** Finance Manager approves a single recommendation */
  action approveAction(
    flaggedAssetId : UUID
  ) returns { success: Boolean };

  /** Finance Manager rejects a single recommendation */
  action rejectAction(
    flaggedAssetId : UUID,
    reason         : String
  ) returns { success: Boolean };

  /** Finance Manager bulk-approves recommendations */
  action massApproveActions(
    flaggedAssetIds : array of UUID
  ) returns { approved: Integer };

  /** Execute S/4HANA write-back for all approved assets in the given IDs */
  action executeApprovedActions(
    flaggedAssetIds : array of UUID
  ) returns { executed: Integer; failed: Integer };

  /** Check if a fixed asset has linked Purchase Orders (reads from EKKN via PO API) */
  action getLinkedPurchaseOrders(masterFixedAsset: String) returns array of {
    purchaseOrder: String;
  };

  /** Reset EXECUTED or FAILED assets back to PENDING for re-review */
  action massResetToPending(
    flaggedAssetIds : array of UUID
  ) returns { reset: Integer };

  /** Returns the currently authenticated user's display information */
  function currentUser() returns {
    id       : String(200);
    name     : String(200);
    email    : String(200);
    initials : String(5);
    isAdmin  : Boolean;
  };

  /** List all admin users (admin only) */
  function listAdmins() returns array of {
    email   : String(200);
    addedBy : String(200);
    addedAt : Timestamp;
  };

  /** Add an admin by email (admin only) */
  action addAdmin(email: String) returns { success: Boolean };

  /** Remove an admin by email (admin only) */
  action removeAdmin(email: String) returns { success: Boolean };

  /** AI-framed diagnosis of a failed asset's S/4HANA write-back error (admin only) */
  action aiDiagnoseError(flaggedAssetId: UUID) returns { text: String };

  // -------------------------------------------------------------------------
  // Email-link endpoints (GET functions — clicked from approval/error emails).
  // Routed through the approuter's xsuaa route so req.user is the acting admin.
  // Each writes a branded HTML confirmation page to the HTTP response.
  // -------------------------------------------------------------------------

  /** Approve/cancel an approval batch from the email buttons */
  function emailDecide(batch: String, decision: String) returns String;

  /** "Send to AI" button on an error email — returns an AI diagnosis page */
  function emailAiDiagnose(batch: String, asset: String) returns String;

  /** "Notify requester & reject" button on an error email */
  function emailRejectNotify(batch: String, asset: String) returns String;
}
