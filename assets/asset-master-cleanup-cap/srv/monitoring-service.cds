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
}
