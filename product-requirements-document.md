# Product Requirements Document (PRD)

**Title:** Asset Master Data Monitor & Cleanup Platform  
**Date:** 2026-08-13  
**Owner:** Finance / Asset Management Team  
**Solution Category:** CAP App (BTP Extension)

---

## Product Purpose & Value Proposition

**Elevator Pitch:**  
Asset master data in SAP S/4HANA quietly accumulates stale, incomplete, and meaningless records over time — assets that were created but never used, capitalized, or properly closed out. This platform gives Finance teams a controlled, automated way to detect, review, and clean those records before they become a compliance or audit liability.

**Business Need:**  
There is currently no mechanism in SAP S/4HANA to automatically detect asset records that were created but never progressed through their lifecycle (never acquired, never capitalized, never deactivated). These records pile up silently, degrading data quality and making audits, reporting, and system performance harder. The business needs a configurable monitoring platform that surfaces these records proactively and provides a governed, auditable path to remediate them.

**Expected Value:**

- Reduction in time spent on manual asset master data reviews
- Fewer stale records polluting financial reports and asset registers
- Auditable trail of every block and delete action taken on asset master data
- Configurable rules that adapt to changing business policies without IT involvement

**Product Objectives (Prioritized):**

1. Automatically detect and surface stale or incomplete asset master records based on configurable rules
2. Provide a governed two-step review and approval workflow (Asset Accountant → Finance Manager) before any action is taken in SAP
3. Execute approved block or delete actions directly in S/4HANA via API — no manual re-entry
4. Send email alerts and provide an in-platform dashboard so users can track and act on flagged records efficiently
5. Allow any authorised user to configure monitoring rules, sensitive fields, and alert schedules without IT support

---

## User Profiles & Personas

### Primary Persona: Alex — Asset Accountant

Alex is a 34-year-old accountant in the corporate finance team, responsible for maintaining the fixed asset register. He runs period-end asset reports and frequently notices that the register is cluttered with assets that appear to have never been used or capitalized. He currently has no systematic way to identify these records — he relies on ad hoc queries or manual spot checks. He is comfortable with SAP but finds the standard transaction views too raw for efficient mass review. Alex needs a clean, focused view of problem assets with enough context to make an informed recommendation without navigating multiple SAP screens.

### Secondary Persona: Maria — Finance Manager

Maria is a 45-year-old Finance Manager who oversees asset accounting for the company. She is responsible for authorizing any changes to the asset register that could affect financial statements. She currently receives informal requests from her team to clean up assets and approves them via email — there is no formal audit trail. Maria needs a platform where she can see exactly which assets her team has flagged, why they were flagged, and what action is being proposed, so she can approve or reject in one place with a full record.

### Other User Types

- **Platform Administrator**: Configures monitoring rules, sensitive fields, alert thresholds, and scheduled scan intervals via the UI. May be Alex, Maria, or a designated data steward.

---

## User Goals & Tasks

### For Alex (Asset Accountant):

**Goals:**
- Quickly identify all asset records that meet stale or incomplete criteria without manual querying
- Review each flagged asset with enough context to recommend an action confidently
- Submit recommendations for Finance Manager approval without email back-and-forth

**Key Tasks:**
- View the dashboard of flagged assets filtered by rule, company code, or asset class
- Drill into an individual asset to see its key field values and why it was flagged
- Mark each flagged asset as Block, Delete, or Keep, optionally adding a comment
- Submit a batch of reviewed assets for manager approval
- Receive email notifications when a new scan has produced newly flagged records

### For Maria (Finance Manager):

**Goals:**
- Review and approve proposed cleanup actions with full context and an auditable trail
- Be confident that any action executed in SAP is traceable back to a business decision

**Key Tasks:**
- View the approval queue of assets where Alex has proposed an action
- Accept or reject each proposed action individually or in mass
- Trigger execution of approved actions to S/4HANA
- View a history log of all past actions taken

---

## Product Principles

1. **Human-in-the-loop for destructive actions**: The platform never deletes or blocks an asset in SAP without explicit Finance Manager approval. No automated write-back without a human sign-off.
2. **Configurable without code**: All monitoring rules, field definitions, and thresholds are managed in the UI. No developer involvement for rule changes.
3. **Transparent by design**: Every flagged record shows exactly which rule triggered it and which field values led to the flag. Users should never wonder why an asset appeared on the list.
4. **Mass and individual actions are equally supported**: The UX must make it as easy to act on 500 assets as on 1.

---

## Business Context

**Current State:**  
Asset master data cleanup is entirely ad hoc. Asset Accountants occasionally run manual SAP queries to find suspicious records. Approvals happen informally via email with no audit trail. There is no scheduled monitoring, no field-level rule configuration, and no API-driven write-back. Cleanup activities are infrequent and incomplete.

**Strategic Alignment:**  
Improving master data quality in the fixed asset register directly supports accurate financial reporting, audit readiness, and efficient period-end close. It aligns with the organisation's data governance objectives and reduces risk in external audit cycles.

**Success Criteria:**

- At least 80% of flagged asset records reviewed and actioned within the same monitoring cycle they were raised
- All block and delete actions in SAP traceable to a specific approval in the platform
- Rule configuration takes less than 5 minutes for a non-technical user
- Scheduled monitoring runs reliably without manual intervention

---

## Goals and Non-Goals

### Goals (In Scope)

- Configurable monitoring rules for asset master data fields (e.g., ZUGDT, AKTIV, DEAKT, XLOEV, ERDAT) with time-based thresholds
- Scheduled and on-demand scanning of asset records from S/4HANA Cloud Private Edition via OData API
- Email alerting to Asset Accountants when new flagged records are produced
- In-platform review dashboard with filter, sort, drill-down, and individual/mass action selection
- Two-step approval workflow: Asset Accountant proposes → Finance Manager approves
- Automatic write-back of approved Block or Delete actions to S/4HANA via OData API
- Full action audit log within the platform
- Mass action support (select all / select by filter → apply action)

### Non-Goals (Out of Scope)

- Monitoring of master data objects other than Fixed Assets (e.g., material master, vendor master) — future extension
- Integration with SAP MDG (Master Data Governance) workflows
- Automated remediation without human approval at any step
- Mobile application — web browser only
- Custom reporting or export to BI tools in initial release

---

## Requirements

### Must-Have Requirements

**REQ-01**: Monitoring Rule Configuration

- **Problem to Solve**: Users have no way to define which asset fields matter for data quality monitoring, or what conditions should trigger a flag.
- **User Story**: As an authorised user, I need to create and manage monitoring rules (field conditions + time thresholds) so that the platform knows which asset records to flag.
- **Acceptance Criteria**:
  - Given I am logged in, when I navigate to Rule Management, then I can create a rule by selecting a table (ANLA), selecting one or more sensitive fields, defining empty/non-empty conditions, and setting an age threshold (in days) for the ERDAT field.
  - Given a rule exists, when I edit it, then changes take effect in the next scheduled scan.
  - Given multiple rules exist, when the scan runs, then each rule is evaluated independently and assets can be flagged by more than one rule.
- **Maps to Objective**: 1, 5
- **Priority Rank**: 1

---

**REQ-02**: Scheduled & On-Demand Asset Scan

- **Problem to Solve**: There is no automated mechanism to retrieve and evaluate asset records against quality rules.
- **User Story**: As an Asset Accountant, I need the platform to automatically scan asset records from S/4HANA on a configured schedule so that I do not have to manually trigger checks.
- **Acceptance Criteria**:
  - Given an active monitoring rule and a configured schedule (e.g., weekly), when the schedule fires, then the platform retrieves asset records from S/4HANA via `CE_FIXEDASSET_0001` OData API and evaluates them against all active rules.
  - Given the scan is complete, when new violations are found, then flagged records are stored in the platform and an email alert is sent.
  - Given I have the appropriate role, when I click "Run Scan Now", then an immediate on-demand scan is triggered.
- **Maps to Objective**: 1
- **Priority Rank**: 2

---

**REQ-03**: Flagged Asset Review Dashboard

- **Problem to Solve**: Asset Accountants have no single place to see all problematic asset records and act on them efficiently.
- **User Story**: As an Asset Accountant, I need a dashboard showing all flagged assets with their key field values so that I can review and recommend actions without navigating SAP transactions.
- **Acceptance Criteria**:
  - Given flagged records exist, when I open the dashboard, then I can see a list of all flagged assets with columns: Asset Number, Description, Company Code, Asset Class, Creation Date (ERDAT), Acquisition Date (ZUGDT), Capitalization Date (AKTIV), Deactivation Date (DEAKT), Deletion Flag (XLOEV), Rule Triggered, and Days Since Creation.
  - Given the list, when I apply a filter (by rule, company code, asset class, or status), then the list updates accordingly.
  - Given a record in the list, when I click it, then I can see a full detail view of the asset.
  - Given I am reviewing an asset, when I select an action (Block / Delete / Keep), then I can optionally add a comment and save my recommendation.
- **Maps to Objective**: 1, 4
- **Priority Rank**: 3

---

**REQ-04**: Mass Action Selection

- **Problem to Solve**: Reviewing and actioning hundreds of assets one by one is impractical and creates a bottleneck in the cleanup cycle.
- **User Story**: As an Asset Accountant, I need to select multiple flagged records at once and assign the same action to all of them so that I can process large volumes efficiently.
- **Acceptance Criteria**:
  - Given the dashboard, when I check individual rows or use "Select All" / "Select by Filter", then I can apply a single action (Block / Delete / Keep) to all selected records in one step.
  - Given a mass action is applied, when I submit for approval, then all selected records appear in the Finance Manager's approval queue as a batch.
- **Maps to Objective**: 2, 4
- **Priority Rank**: 4

---

**REQ-05**: Finance Manager Approval Workflow

- **Problem to Solve**: There is no governed approval step before cleanup actions are executed in SAP, leaving no audit trail.
- **User Story**: As a Finance Manager, I need an approval queue showing all proposed actions from Asset Accountants so that I can review and authorise or reject them before anything changes in SAP.
- **Acceptance Criteria**:
  - Given an Asset Accountant has submitted recommendations, when I log in as Finance Manager, then I see an approval queue with the proposed action, asset details, the recommending user, and any comments.
  - Given items in my approval queue, when I approve a batch, then the platform marks them as approved and queues them for SAP write-back.
  - Given items in my approval queue, when I reject a specific item, then it is returned to the Asset Accountant with the rejection reason.
- **Maps to Objective**: 2
- **Priority Rank**: 5

---

**REQ-06**: Automatic Write-Back to S/4HANA

- **Problem to Solve**: Even after approval, someone must manually execute the change in SAP — creating re-work and opportunities for error.
- **User Story**: As a Finance Manager, I need the platform to automatically execute approved block and delete actions in S/4HANA so that I do not have to re-enter decisions manually.
- **Acceptance Criteria**:
  - Given an approved "Delete" action, when execution is triggered, then the platform calls the `CE_FIXEDASSETRETIREMENT_0001` or equivalent retirement OData API and records the SAP response.
  - Given an approved "Block" action, when execution is triggered, then the platform calls the Fixed Asset Change API to set the deletion flag (XLOEV) and records the SAP response.
  - Given an API call fails, when the failure occurs, then the platform records the error, marks the action as "Failed", and notifies the Finance Manager.
  - Given an action completes successfully, when confirmed by SAP, then the record is marked as "Actioned" with a timestamp and the SAP document number.
- **Maps to Objective**: 3
- **Priority Rank**: 6

---

**REQ-07**: Email Alerting

- **Problem to Solve**: Asset Accountants are not notified when new flagged records require their attention.
- **User Story**: As an Asset Accountant, I need to receive an email when a monitoring scan finds new flagged records so that I can review them without having to check the platform manually.
- **Acceptance Criteria**:
  - Given a scan has completed and new violations were found, when the scan finishes, then an email is sent to configured Asset Accountant recipients summarising the number of new flagged records, the rules triggered, and a link to the dashboard.
  - Given no new violations were found, when the scan completes, then no email is sent.
  - Given I am a Finance Manager, when Asset Accountant recommendations are submitted for my approval, then I receive an email notification with a link to the approval queue.
- **Maps to Objective**: 4
- **Priority Rank**: 7

---

**REQ-08**: Audit Log

- **Problem to Solve**: There is no traceable record of who reviewed, who approved, and when actions were executed on asset records.
- **User Story**: As a Finance Manager or auditor, I need a full log of all review and action events so that I can demonstrate governance over asset master data changes.
- **Acceptance Criteria**:
  - Given any action (recommendation, approval, rejection, execution, failure), when it occurs, then it is recorded in the audit log with: timestamp, user, action type, asset number, rule triggered, and outcome.
  - Given the audit log, when I apply a date range or asset number filter, then I can retrieve a filtered log view.
- **Maps to Objective**: 2, 3
- **Priority Rank**: 8

---

### High-Want Requirements

**REQ-09**: Rule Deactivation & Versioning

- **Problem to Solve**: Rules change over time. Users need to deactivate rules without deleting them and track what rules were active during a given scan.
- **User Story**: As an authorised user, I need to deactivate a monitoring rule and see which rule version was active during any historical scan.
- **Priority Rank**: 1

---

**REQ-10**: Asset Name / Description Quality Check

- **Problem to Solve**: Assets with meaningless names like "dummy" or "test" should also be surfaced even if field conditions are met.
- **User Story**: As an authorised user, I need to define keyword-based rules (e.g., description contains "dummy") so that naming quality violations are also flagged.
- **Priority Rank**: 2

---

### Nice-to-Have Requirements

**REQ-11**: Export to CSV / Excel

- **Problem to Solve**: Users may want to work through a list offline or share it with stakeholders outside the platform.
- **Priority Rank**: 1

**REQ-12**: Trend Dashboard

- **Problem to Solve**: Management wants to see whether the asset data quality is improving over time.
- **Priority Rank**: 2

---

## Non-Functional Requirements

### Performance

- **Latency**: Dashboard must load within 3 seconds for lists of up to 5,000 flagged records.
- **Throughput**: The scan job must support paginated retrieval of up to 50,000 asset records per scan cycle.

### Reliability

- **Availability**: 99.5% uptime during business hours (aligned with BTP SLA).
- **Fallback**: If the S/4HANA OData API is unavailable during a scheduled scan, the scan is retried up to 3 times before generating an error notification to the administrator.

### Explainability

- **Traceability**: Each flagged record must clearly display which rule triggered it and which field values caused the flag.
- **Decision Logging**: Every user action (recommendation, approval, write-back) is logged with full context in the audit log.

---

## Solution Architecture

**Architecture Overview:**  
A CAP Node.js backend deployed on SAP BTP Cloud Foundry, with a React (SAP UI5 Web Components) frontend served as an HTML5 application. The backend connects to SAP S/4HANA Cloud Private Edition via OData APIs using SAP Destination service. A scheduled CAP job handles periodic scans. Email notifications are dispatched via SAP BTP Alert Notification service.

**Key Components:**

- **CAP Backend (Node.js)**: Rule engine, scan job scheduler, approval workflow logic, audit log persistence, OData API integration layer
- **React Frontend (SAP UI5 Web Components)**: Rule Builder UI, Flagged Asset Dashboard, Approval Queue, Audit Log view
- **SAP HANA Cloud (persistence)**: Stores rules, flagged records, recommendations, approvals, and audit log
- **SAP BTP Destination Service**: Manages the secure connection to S/4HANA Cloud Private Edition
- **SAP BTP Alert Notification Service**: Dispatches email alerts on scan completion and approval events

**Integration Points:**

- `CE_FIXEDASSET_0001` (OData, S/4HANA): Read asset master data records — inbound to platform, on scan cycle
- `CE_FIXEDASSETRETIREMENT_0001` (OData, S/4HANA): Post asset retirement (delete action) — outbound from platform, on approved action
- `FIXEDASSETCHANGE` (SOAP/OData, S/4HANA): Update deletion flag XLOEV (block action) — outbound from platform, on approved action

**Deployment Environments:**

- **Development**: Isolated BTP subaccount, connected to S/4HANA sandbox/test system
- **Production**: Dedicated BTP subaccount, connected to S/4HANA production system with restricted write credentials

---

### Automation & Agent Behaviour

**Automation Level:** Rule-based with scheduled automation

**Actions the system performs without human approval:**

- Retrieving asset records from S/4HANA on the configured scan schedule
- Evaluating records against active monitoring rules
- Sending email notifications to configured recipients

**Actions that require human review or approval:**

- Marking a flagged asset as Block, Delete, or Keep (Asset Accountant)
- Approving or rejecting proposed actions before any SAP write-back (Finance Manager)

**Model or engine used:** Custom rule engine (CAP backend) — no AI/ML; pure deterministic field evaluation logic

**Tools or connectors invoked:**

- `CE_FIXEDASSET_0001`: Read asset master data — read-only
- `CE_FIXEDASSETRETIREMENT_0001`: Post retirement — write / high-risk
- `FIXEDASSETCHANGE`: Update block flag — write / high-risk

**Guardrails & fail-safes:**

- No destructive action (block or delete) is ever sent to S/4HANA without an explicit Finance Manager approval recorded in the platform
- If an S/4HANA write-back API call fails, the action is marked as "Failed" and an alert is raised — the record remains in an actionable state for retry
- The platform operates in read-only mode against S/4HANA during scan cycles; write access is only invoked post-approval

---

## Milestones

### M1: Rules Configured

- **Description**: At least one active monitoring rule with sensitive fields and a time threshold has been created in the platform.
- **Achieved when**: A rule record exists in the database with status = Active and at least one field condition and one age threshold defined.
- **Log on achievement**: `M1.achieved: monitoring rule created and activated — rule_id={id}, field_count={n}, threshold_days={d}`
- **Log on miss**: `M1.missed: no active monitoring rules found — scan cannot proceed`

### M2: Scan Completed

- **Description**: The platform has retrieved asset records from S/4HANA and evaluated them against all active rules, producing a flagged record set.
- **Achieved when**: A scan run record exists with status = Completed, total_records_evaluated > 0, and the scan_end_timestamp is populated.
- **Log on achievement**: `M2.achieved: scan completed — scan_id={id}, records_evaluated={n}, records_flagged={m}, duration_ms={t}`
- **Log on miss**: `M2.missed: scan did not complete — scan_id={id}, error={message}`

### M3: Alerts Dispatched

- **Description**: Email notifications have been sent to Asset Accountants summarising newly flagged records from the completed scan.
- **Achieved when**: At least one email notification has been dispatched with a reference to the completed scan run.
- **Log on achievement**: `M3.achieved: alert emails dispatched — scan_id={id}, recipients={n}, flagged_count={m}`
- **Log on miss**: `M3.missed: alert dispatch failed or no new violations found — scan_id={id}`

### M4: Review Done

- **Description**: Asset Accountant has reviewed all flagged records from a scan cycle and assigned a recommended action to each.
- **Achieved when**: All flagged records from a scan cycle have a status of Recommended (Block / Delete / Keep) with a reviewing user ID recorded.
- **Log on achievement**: `M4.achieved: all flagged records reviewed — scan_id={id}, reviewed_by={user}, block={n}, delete={m}, keep={k}`
- **Log on miss**: `M4.missed: review incomplete — scan_id={id}, pending_records={n}`

### M5: Manager Approved

- **Description**: Finance Manager has reviewed and approved (or rejected) the proposed actions from the Asset Accountant.
- **Achieved when**: All submitted recommendations have been either Approved or Rejected by a Finance Manager user, with approval_timestamp recorded.
- **Log on achievement**: `M5.achieved: approval complete — batch_id={id}, approved_by={user}, approved={n}, rejected={m}`
- **Log on miss**: `M5.missed: approval pending — batch_id={id}, awaiting_manager_action`

### M6: Actions Executed

- **Description**: Approved block or delete actions have been written back to S/4HANA via API and the results confirmed.
- **Achieved when**: All approved records have a write-back status of Success or Failed, with the SAP response recorded.
- **Log on achievement**: `M6.achieved: write-back complete — batch_id={id}, success={n}, failed={m}`
- **Log on miss**: `M6.missed: write-back not triggered or all calls failed — batch_id={id}`

---

## Risks, Assumptions, and Dependencies

### Risks

- **Block flag API coverage**: The standard Fixed Asset Change API must support updating XLOEV. If this field is not exposed, the block action may require a different API or workaround — needs validation during technical spike.
- **Data volume and API rate limits**: For large asset portfolios (>50,000 records), the scan job must be designed with pagination and retry logic to avoid hitting S/4HANA API throttle limits.
- **Email deliverability**: Dependency on SAP BTP Alert Notification service; SMTP configuration must be validated in the target landscape.

### Assumptions (Validate These)

- S/4HANA Cloud Private Edition OData API `CE_FIXEDASSET_0001` exposes ANLA table fields including ZUGDT, AKTIV, DEAKT, XLOEV, and ERDAT.
- The organisation has a BTP subaccount with SAP HANA Cloud and Destination Service available.
- Finance Managers and Asset Accountants will be provisioned as distinct roles in the BTP Identity Authentication Service.
- There is no requirement for multi-company-code isolation at the database level in the initial release.

### Dependencies

- SAP S/4HANA Cloud Private Edition connectivity (OData API access via SAP Destination Service)
- SAP BTP: Cloud Foundry runtime, HANA Cloud, Destination Service, Alert Notification Service
- Identity Authentication Service (IAS) for role-based access control

---

## Open Questions

- Does `CE_FIXEDASSET_0001` include XLOEV (deletion flag) as a writable field, or does a separate API need to be used?
- What is the expected average number of assets per scan cycle in the target landscape (to size the job and pagination strategy)?
- Should the "Keep" recommendation suppress the asset from future scans for a configurable grace period, or should it simply close the current cycle's flag?
- Are there multiple company codes in scope for the initial release, and does the rule configuration need to be scoped per company code?

---

## Appendix

### Glossary

| Term | Definition |
|---|---|
| ANLA | SAP fixed asset master record table |
| ERDAT | Asset creation date (ANLA field) |
| ZUGDT | First acquisition date (ANLA field) |
| AKTIV | Capitalization date (ANLA field) |
| DEAKT | Deactivation date (ANLA field) |
| XLOEV | Deletion flag (ANLA field) |
| Flagged Record | An asset master record that has violated one or more active monitoring rules |
| Scan Cycle | One complete execution of the monitoring job — retrieve, evaluate, flag, alert |
| Write-back | The act of sending an approved action (block/delete) to S/4HANA via OData API |

### References

- SAP Fixed Asset Master Data API: `CE_FIXEDASSET_0001` — SAP Business Accelerator Hub
- SAP Fixed Asset Retirement API: `CE_FIXEDASSETRETIREMENT_0001` — SAP Business Accelerator Hub
- SAP BTP Alert Notification Service documentation
- SAP CAP Node.js documentation — cap.cloud.sap
