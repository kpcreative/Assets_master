# Specification: asset-master-cleanup-cap

> **Guidelines**: Read [guidelines.md](../guidelines.md) and [guidelines-cap.md](../guidelines-cap.md) before executing ANY tasks below. Follow all constraints described there throughout execution.

## Basic Setup

- [ ] Read `product-requirements-document.md` and `intent.md` for full business context before starting
- [ ] Invoke the `cap-development` skill from `assets/asset-master-cleanup-cap/` to set up the CAP project structure
- [ ] Install dependencies (`npm install`), validate the project starts (`cds watch`) and responds
- [ ] Create `assets/asset-master-cleanup-cap/asset.yaml` with the standard CAP asset descriptor (name: `asset-master-cleanup`)

---

## Data Model (CDS)

- [ ] Define entity `MonitoringRules` in `db/schema.cds`:
  - Fields: `ID` (UUID, key), `name` (String), `description` (String), `isActive` (Boolean, default true), `targetTable` (String, default 'ANLA'), `ageDaysThreshold` (Integer), `sensitiveFields` (Composition of many `SensitiveFieldConditions`), `createdBy` (String), `createdAt` (DateTime), `modifiedAt` (DateTime)
- [ ] Define entity `SensitiveFieldConditions` in `db/schema.cds`:
  - Fields: `ID` (UUID, key), `rule` (Association to `MonitoringRules`), `fieldName` (String — e.g. ZUGDT, AKTIV, DEAKT, XLOEV), `conditionType` (String — enum: IS_EMPTY, IS_NOT_EMPTY, CONTAINS_KEYWORD), `keywordValue` (String, nullable — used when conditionType = CONTAINS_KEYWORD)
- [ ] Define entity `ScanRuns` in `db/schema.cds`:
  - Fields: `ID` (UUID, key), `status` (String — enum: RUNNING, COMPLETED, FAILED), `startedAt` (DateTime), `completedAt` (DateTime), `totalRecordsEvaluated` (Integer), `totalRecordsFlagged` (Integer), `errorMessage` (String, nullable), `triggeredBy` (String)
- [ ] Define entity `FlaggedAssets` in `db/schema.cds`:
  - Fields: `ID` (UUID, key), `scanRun` (Association to `ScanRuns`), `rule` (Association to `MonitoringRules`), `companyCode` (String(4)), `masterFixedAsset` (String(12)), `fixedAsset` (String(4)), `assetDescription` (String(50)), `assetClass` (String(8)), `creationDate` (Date), `acquisitionValueDate` (Date, nullable), `assetCapitalizationDate` (Date, nullable), `assetDeactivationDate` (Date, nullable), `daysSinceCreation` (Integer), `triggeringFieldsSummary` (String), `reviewStatus` (String — enum: PENDING, RECOMMENDED_BLOCK, RECOMMENDED_DELETE, RECOMMENDED_KEEP, APPROVED, REJECTED, EXECUTED, FAILED), `reviewedBy` (String, nullable), `reviewedAt` (DateTime, nullable), `reviewComment` (String, nullable), `approvedBy` (String, nullable), `approvedAt` (DateTime, nullable), `writeBackStatus` (String, nullable — SUCCESS / FAILED), `writeBackTimestamp` (DateTime, nullable), `writeBackSapResponse` (String, nullable)
- [ ] Define entity `AuditLog` in `db/schema.cds`:
  - Fields: `ID` (UUID, key), `eventType` (String — e.g. RULE_CREATED, SCAN_STARTED, ASSET_REVIEWED, ACTION_APPROVED, WRITEBACK_SUCCESS, WRITEBACK_FAILED), `performedBy` (String), `performedAt` (DateTime), `entityType` (String), `entityId` (String), `details` (String)
- [ ] Define entity `AlertRecipients` in `db/schema.cds`:
  - Fields: `ID` (UUID, key), `email` (String), `role` (String — ASSET_ACCOUNTANT / FINANCE_MANAGER), `isActive` (Boolean, default true)
- [ ] Run `cds compile db/schema.cds` and fix any errors

---

## CAP Services (CDS)

- [ ] Define `MonitoringService` in `srv/monitoring-service.cds`:
  - Expose: `MonitoringRules` (full CRUD), `SensitiveFieldConditions` (full CRUD), `AlertRecipients` (full CRUD)
  - Expose read-only: `ScanRuns`, `FlaggedAssets`, `AuditLog`
  - Expose actions:
    - `triggerScan()` — starts an on-demand scan run (returns ScanRun ID)
    - `submitRecommendation(flaggedAssetId: UUID, action: String, comment: String)` — Asset Accountant sets review status
    - `massSubmitRecommendation(flaggedAssetIds: many UUID, action: String, comment: String)` — bulk version
    - `approveAction(flaggedAssetId: UUID)` — Finance Manager approves
    - `rejectAction(flaggedAssetId: UUID, reason: String)` — Finance Manager rejects
    - `massApproveActions(flaggedAssetIds: many UUID)` — bulk approve
    - `executeApprovedActions(batchIds: many UUID)` — triggers S/4HANA write-back for approved records
- [ ] Run `cds compile srv/` and fix any errors

---

## Mock Data

- [ ] Create `db/data/MonitoringRules.csv` with 2 sample rules:
  - Rule 1: "Uncapitalized Assets (>90 days)", ageDaysThreshold=90, isActive=true
  - Rule 2: "Dummy Asset Names", ageDaysThreshold=30, isActive=true
- [ ] Create `db/data/SensitiveFieldConditions.csv` with field conditions for the above rules:
  - Rule 1 conditions: ZUGDT IS_EMPTY, AKTIV IS_EMPTY, DEAKT IS_EMPTY
  - Rule 2 conditions: FixedAssetDescription CONTAINS_KEYWORD (keywordValue="dummy")
- [ ] Create `db/data/AlertRecipients.csv` with 2 sample recipients (1 ASSET_ACCOUNTANT, 1 FINANCE_MANAGER)
- [ ] Create `db/data/ScanRuns.csv` with 1 completed sample scan run
- [ ] Create `db/data/FlaggedAssets.csv` with at least 8 sample flagged assets in various states (PENDING, RECOMMENDED_DELETE, APPROVED, EXECUTED) covering different rules

---

## S/4HANA Integration Layer (Mock)

- [ ] Create `srv/s4-integration.js` — a module that abstracts all S/4HANA API calls:
  - `fetchFixedAssets(companyCode)` — calls `GET /FixedAsset?$expand=_FixedAssetLedger` on `CE_FIXEDASSET_0001` OData service; returns array of asset records with fields: CompanyCode, MasterFixedAsset, FixedAsset, FixedAssetDescription, AssetClass, CreationDate, and from `_FixedAssetLedger`: AcquisitionValueDate, AssetCapitalizationDate, AssetDeactivationDate
  - `retireAsset(companyCode, masterFixedAsset, fixedAsset)` — calls `CE_FIXEDASSETRETIREMENT_0001` to post asset retirement
  - `blockAsset(companyCode, masterFixedAsset, fixedAsset)` — calls the `Change` action on `CE_FIXEDASSET_0001` to set AssetDeactivationDate (block flag equivalent)
  - **Mock mode**: When `S4_BASE_URL` env variable is not set, return realistic mock data from a local fixture file `srv/fixtures/s4-assets-mock.json`
- [ ] Create `srv/fixtures/s4-assets-mock.json` with 20 mock fixed asset records including a mix of: assets with all dates populated (healthy), assets with no dates (stale), assets with description containing "dummy", assets created over 90 days ago with no acquisition date

---

## Rule Engine (Scan Logic)

- [ ] Create `srv/rule-engine.js` — the core scanning logic:
  - `evaluateAsset(asset, rules)` — evaluates a single asset record against all active rules; returns array of violations (which rule, which fields triggered it)
  - `evaluateAgeCondition(creationDate, thresholdDays)` — returns true if asset is older than threshold
  - `evaluateFieldCondition(asset, fieldCondition)` — handles IS_EMPTY, IS_NOT_EMPTY, CONTAINS_KEYWORD logic
    - Map API field names to condition fields: AcquisitionValueDate→ZUGDT, AssetCapitalizationDate→AKTIV, AssetDeactivationDate→DEAKT, FixedAssetDescription→FixedAssetDescription
  - `runScan(scanRunId, db)` — orchestrates full scan: fetch active rules, fetch assets from S/4HANA (via s4-integration.js), evaluate each asset, persist `FlaggedAssets`, update `ScanRun` status and counts
- [ ] Write unit tests for `rule-engine.js`:
  - Test: asset older than threshold with empty ZUGDT and AKTIV → flagged
  - Test: asset with description "dummy test asset" → flagged by CONTAINS_KEYWORD rule
  - Test: healthy asset (all dates set) → not flagged
  - Test: asset newer than threshold → not flagged even if fields empty

---

## Email Notification

- [ ] Create `srv/email-service.js` — email notification module:
  - `sendScanAlert(scanRunId, newFlaggedCount, recipientEmails)` — sends scan summary email
  - `sendApprovalRequest(batchSummary, managerEmails)` — notifies Finance Managers of pending approval
  - **Mock mode**: When `EMAIL_SERVICE_URL` env var is not set, log email content to console instead of sending
  - When env var is set, POST to SAP BTP Alert Notification Service REST API

---

## Custom Handlers

- [ ] Create `srv/monitoring-service.js` — CAP custom handler:

  **`triggerScan` action handler:**
  - Create a new `ScanRun` with status=RUNNING
  - Call `runScan(scanRunId, db)` from rule-engine.js
  - On completion: update ScanRun to COMPLETED with counts; write AuditLog entry (M2)
  - If new flagged records found: fetch ASSET_ACCOUNTANT alert recipients and call `sendScanAlert` (M3)
  - On failure: update ScanRun to FAILED with error message; write AuditLog entry (M2.missed)
  - Log: `M2.achieved: scan completed — scan_id={id}, records_evaluated={n}, records_flagged={m}`

  **`submitRecommendation` action handler:**
  - Validate action is one of: RECOMMENDED_BLOCK, RECOMMENDED_DELETE, RECOMMENDED_KEEP
  - Validate flaggedAsset exists and is in PENDING status
  - Update `FlaggedAssets` record: reviewStatus, reviewedBy, reviewedAt, reviewComment
  - Write AuditLog entry

  **`massSubmitRecommendation` action handler:**
  - Loop over flaggedAssetIds and apply same logic as `submitRecommendation`
  - Write single AuditLog entry for the batch

  **`approveAction` handler:**
  - Validate flaggedAsset exists and is in RECOMMENDED_BLOCK or RECOMMENDED_DELETE status
  - Update reviewStatus to APPROVED, set approvedBy and approvedAt
  - Write AuditLog entry (M5)
  - Log: `M5.achieved: approval complete — asset_id={id}, approved_by={user}`

  **`rejectAction` handler:**
  - Update reviewStatus to REJECTED with reason in reviewComment
  - Write AuditLog entry

  **`massApproveActions` handler:**
  - Bulk approve, write batch AuditLog entry

  **`executeApprovedActions` handler:**
  - For each approved record:
    - If RECOMMENDED_DELETE: call `s4Integration.retireAsset()`
    - If RECOMMENDED_BLOCK: call `s4Integration.blockAsset()`
    - On success: set writeBackStatus=SUCCESS, writeBackTimestamp, writeBackSapResponse, reviewStatus=EXECUTED
    - On failure: set writeBackStatus=FAILED, reviewStatus=FAILED, record error
  - Write AuditLog entry per record (M6)
  - Log: `M6.achieved: write-back complete — asset_id={id}, action={action}, status=SUCCESS`

- [ ] Write tests for custom handler logic:
  - Test `triggerScan`: mock rule engine, verify ScanRun created and updated
  - Test `submitRecommendation`: verify status transition and audit log
  - Test `approveAction`: verify status transition RECOMMENDED_DELETE → APPROVED
  - Test `executeApprovedActions`: mock S/4HANA integration, verify status set to EXECUTED on success and FAILED on error

---

## Scheduled Monitoring Job

- [ ] Add a CAP scheduled job (using `cds.schedule` or equivalent) in `srv/scheduler.js`:
  - Default schedule: daily at 06:00 (configurable via env var `SCAN_CRON_SCHEDULE`)
  - Calls same logic as `triggerScan` action
  - Logs scheduler start/stop to console
  - Log: `M1.achieved: monitoring rule created and activated — rule_id={id}` (on first-run rule validation check)

---

## React Frontend (UI)

- [ ] Follow the `cap-development` skill to scaffold the React frontend in `assets/asset-master-cleanup-cap/ui/`

- [ ] **Page: Rule Management (`/rules`)**
  - List all monitoring rules with columns: Name, Target Table, Age Threshold (days), Status (Active/Inactive), No. of Conditions, Actions
  - "New Rule" button opens a form: Name, Description, Age Threshold (days input), Sensitive Fields section
  - Sensitive Fields section: add/remove field conditions — dropdown for Field Name (ZUGDT, AKTIV, DEAKT, XLOEV, FixedAssetDescription), dropdown for Condition Type (IS_EMPTY, IS_NOT_EMPTY, CONTAINS_KEYWORD), text input for Keyword (shown only for CONTAINS_KEYWORD)
  - Edit and Delete actions per rule row
  - "Run Scan Now" button at top of page — triggers `triggerScan` action and shows toast notification

- [ ] **Page: Flagged Asset Dashboard (`/dashboard`)**
  - Filter bar: Rule (dropdown), Company Code (text), Asset Class (text), Status (dropdown), Days Since Creation (range)
  - Asset list table with columns: Asset Number, Sub-Number, Company Code, Description, Asset Class, Creation Date, Days Old, Acquisition Date, Capitalization Date, Deactivation Date, Rule Triggered, Status, Actions
  - Colour coding: PENDING = amber, RECOMMENDED = blue, APPROVED = green, EXECUTED = grey, FAILED = red
  - Row click opens Asset Detail panel (slide-in) showing all field values and why it was flagged
  - Per-row action dropdown: "Recommend Block", "Recommend Delete", "Recommend Keep" (Asset Accountant only)
  - "Submit for Approval" button sends selected records to Finance Manager queue
  - Multi-select checkboxes + "Select All" / "Select Filtered" for mass actions
  - Mass action bar appears on selection: apply action to all selected + Submit button

- [ ] **Page: Approval Queue (`/approvals`)**
  - Filterable list of records in RECOMMENDED_BLOCK or RECOMMENDED_DELETE status
  - Columns: Asset Number, Description, Recommended Action, Recommended By, Comment, Days Old, Rule
  - "Approve" and "Reject" buttons per row
  - Mass approve: select multiple rows + "Approve Selected" button
  - "Execute Approved Actions" button — calls `executeApprovedActions` for all APPROVED records
  - Rejection dialog with reason text input

- [ ] **Page: Audit Log (`/audit`)**
  - Filterable by date range, event type, user, asset number
  - Table columns: Timestamp, Event Type, Performed By, Entity Type, Entity ID, Details
  - Export button (CSV) — optional

- [ ] **Page: Alert Recipients (`/settings`)**
  - List of recipients with columns: Email, Role, Active
  - Add/Edit/Delete recipients

- [ ] **Navigation**: Left sidebar or top nav with links to all pages; show badge count on "Approval Queue" nav item for pending approvals

---

## Validation

- [ ] Run `cds compile srv/` — must pass with zero errors
- [ ] Run `npm test` — all custom handler tests must pass
- [ ] Run `cds watch` — service must start without errors
- [ ] Curl `GET /odata/v4/monitoring/MonitoringRules` — must return the 2 seeded rules
- [ ] Curl `POST /odata/v4/monitoring/triggerScan` — must return a scan run ID and produce flagged assets
- [ ] Curl `GET /odata/v4/monitoring/FlaggedAssets` — must return flagged asset records
- [ ] Verify the React UI loads and the Dashboard page renders the flagged asset table
- [ ] Verify mass action selection works on the Dashboard page
- [ ] Verify Approval Queue shows records after submitting recommendations
