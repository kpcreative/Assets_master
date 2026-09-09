namespace assetmonitor;

using { cuid, managed } from '@sap/cds/common';

// ---------------------------------------------------------------------------
// Monitoring Rules
// ---------------------------------------------------------------------------
entity MonitoringRules : cuid, managed {
  name                : String(100)  @mandatory;
  description         : String(500);
  isActive            : Boolean      default true;
  targetTable         : String(10)   default 'ANLA';
  ageDaysThreshold    : Integer      @mandatory;
  conditions          : Composition of many SensitiveFieldConditions on conditions.rule = $self;
}

// ---------------------------------------------------------------------------
// Field conditions attached to a rule
// ---------------------------------------------------------------------------
entity SensitiveFieldConditions : cuid {
  rule          : Association to MonitoringRules @mandatory;
  fieldName     : String(50)  @mandatory; // e.g. ZUGDT, AKTIV, DEAKT, XLOEV, FixedAssetDescription
  conditionType : String(20)  @mandatory; // IS_EMPTY | IS_NOT_EMPTY | CONTAINS_KEYWORD
  keywordValue  : String(200);            // only for CONTAINS_KEYWORD
}

// ---------------------------------------------------------------------------
// Scan Runs
// ---------------------------------------------------------------------------
entity ScanRuns : cuid {
  status                 : String(20) default 'RUNNING';  // RUNNING | COMPLETED | FAILED
  startedAt              : DateTime;
  completedAt            : DateTime;
  totalRecordsEvaluated  : Integer default 0;
  totalRecordsFlagged    : Integer default 0;
  errorMessage           : String(1000);
  triggeredBy            : String(100);
  flaggedAssets          : Association to many FlaggedAssets on flaggedAssets.scanRun = $self;
}

// ---------------------------------------------------------------------------
// Flagged Assets
// ---------------------------------------------------------------------------
entity FlaggedAssets : cuid {
  scanRun                  : Association to ScanRuns;
  rule                     : Association to MonitoringRules;
  companyCode              : String(4);
  masterFixedAsset         : String(12);
  fixedAsset               : String(4);
  assetDescription         : String(50);
  assetClass               : String(8);
  creationDate             : Date;
  acquisitionValueDate     : Date;
  assetCapitalizationDate  : Date;
  assetDeactivationDate    : Date;
  daysSinceCreation        : Integer;
  isAlreadyBlocked         : Boolean default false;  // true = AccountIsBlockedForPosting in S/4 but still violates a rule
  triggeringFieldsSummary  : String(500);
  reviewStatus             : String(30) default 'PENDING';
    // PENDING | RECOMMENDED_BLOCK | RECOMMENDED_DELETE | RECOMMENDED_KEEP
    // | APPROVED | REJECTED | EXECUTED | FAILED
  reviewedBy               : String(100);
  reviewedAt               : DateTime;
  reviewComment            : String(500);
  approvedBy               : String(100);
  approvedAt               : DateTime;
  writeBackStatus          : String(20);  // SUCCESS | FAILED
  writeBackTimestamp       : DateTime;
  writeBackSapResponse     : String(1000);
  aiRecommendedAction      : String(20);   // DELETE | BLOCK | RETIRE
  aiReasoningSummary       : String(500);
  aiConfidenceScore        : Decimal(3,2);
  recommendedAction        : String(20);   // RECOMMENDED_BLOCK | RECOMMENDED_DELETE | RECOMMENDED_KEEP (survives APPROVE)
}

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------
entity AuditLog : cuid {
  eventType    : String(50)   @mandatory;
  // RULE_CREATED | SCAN_STARTED | SCAN_COMPLETED | ASSET_REVIEWED
  // | ACTION_APPROVED | ACTION_REJECTED | WRITEBACK_SUCCESS | WRITEBACK_FAILED
  performedBy  : String(100);
  performedAt  : DateTime;
  entityType   : String(50);
  entityId     : String(36);
  details      : String(2000);
}

// ---------------------------------------------------------------------------
// Alert Recipients
// ---------------------------------------------------------------------------
entity AlertRecipients : cuid {
  email    : String(200) @mandatory;
  role     : String(30)  @mandatory;   // ASSET_ACCOUNTANT | FINANCE_MANAGER
  isActive : Boolean     default true;
}
