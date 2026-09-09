# Asset Master Data Monitor & Cleanup Platform

## Business challenge

Over time, asset master data in SAP S/4HANA (ANLA table) accumulates junk and incomplete records — assets that were created but never capitalized, records with meaningless names like "dummy", and entries where key fields such as acquisition date (ZUGDT), capitalization date (AKTIV), deactivation date (DEAKT), and deletion flag (XLOEV) remain empty long after the asset creation date (ERDAT).

There is no automated mechanism to detect, alert on, or remediate these stale records. Users need a platform where they can:
- Define which fields in the asset master are "sensitive/key monitoring fields"
- Set configurable rules (e.g. if ERDAT > 3 months old AND ZUGDT and AKTIV are blank AND DEAKT and XLOEV are not set → flag for review)
- Receive alerts via email and view a dashboard of flagged assets
- Take individual or mass action (block, delete, or keep) on flagged records
- Have approved actions written back automatically to S/4HANA Cloud Private Edition via API

The two primary user roles are **Asset Accountant** (reviews flagged records and proposes actions) and **Finance Manager** (approves and triggers final block/delete actions in SAP).

## Key Milestones

1. **Rules Configured** — User has defined at least one monitoring rule with sensitive fields and a time threshold
2. **Scan Completed** — Platform has queried S/4HANA, evaluated all asset records against active rules, and produced a flagged list
3. **Alerts Dispatched** — Email notifications sent to Asset Accountants with a summary of flagged assets
4. **Review Done** — Asset Accountant has reviewed each flagged record and marked a recommended action (block / delete / keep)
5. **Manager Approved** — Finance Manager has reviewed and approved the proposed actions
6. **Actions Executed** — Approved block or delete actions written back to S/4HANA via API; confirmation recorded in platform

## Business Architecture (RBA)

### End-to-End Process

Acquire to Decommission (Generic)

### Process Hierarchy

```
Acquire to Decommission (E2E)
└── Manage Assets (generic)
    └── Manage asset data and collaboration (BPS-379)
        └── Manage asset master data
└── Acquire to Onboard (generic)
    └── Acquire asset (BPS-380)
        └── Acquire asset
└── Operate to Maintain (generic)
    └── Plan asset maintenance (BPS-377)
        └── Monitor asset health and maintenance demand
```

### Summary

The challenge maps primarily to "Manage asset data and collaboration" (BPS-379) for master data quality monitoring and remediation, with supporting context from asset acquisition lifecycle (BPS-380) and monitoring triggers from asset maintenance planning (BPS-377). Industry variants include Tangible Assets and Real Estate.

## Fit Gap Analysis

| Requirement (business) | Standard asset(s) found | API ORD ID | MCP Server ORD ID | MCP Server Version | Gap? | Notes / assumptions |
| ---------------------- | ----------------------- | ---------- | ----------------- | ------------------ | ---- | ------------------- |
| Read and monitor asset master data from S/4HANA | SAP S/4HANA Cloud Private Edition – Asset Data and Information Management (SC5257) | `sap.s4:apiResource:CE_FIXEDASSET_0001:v1` | — | — | No | OData API available; no MCP server found |
| Block or delete stale asset records in S/4HANA | SAP S/4HANA Cloud Private Edition – Asset Data and Information Management (SC5257) | `sap.s4:apiResource:CE_FIXEDASSETRETIREMENT_0001:v1` | — | — | Partial | Retirement API covers financial retirement; block flag (XLOEV) update requires Change API |
| Asset retirement / write-back action | SAP S/4HANA Cloud Private Edition | `sap.s4:apiResource:OP_FIXEDASSETRETIREMENT_0001:v1` | — | — | No | On-Premise variant also available |
| Configurable monitoring rules UI | No standard SAP product covers rule-builder for custom field monitoring | — | — | — | Yes | Custom CAP application required |
| Email alerting on schedule | No standard alerting without custom build | — | — | — | Yes | Custom scheduled job + email notification required |
| In-platform review dashboard | No standard product | — | — | — | Yes | Custom React frontend required |
| Mass action (block/delete) approval workflow | No standard product for this use case | — | — | — | Yes | Approval step built into custom app |

### Key findings
- SAP S/4HANA Cloud Private Edition provides the core APIs to read asset master data and trigger retirement/change actions — these will be the integration backbone.
- No MCP server was resolvable for the Fixed Asset APIs at this time; direct OData API integration will be used.
- No standard SAP product covers configurable monitoring rules, dashboard review, or the approval-to-action workflow — all require custom development.
- The platform will be built as a CAP application (backend + React frontend) with a scheduled monitoring job.
- The ANLA table fields ZUGDT, AKTIV, DEAKT, XLOEV, ERDAT are the primary evaluation fields; the rule engine must support extensible field configurations.
- A two-role model (Asset Accountant → review; Finance Manager → approve & execute) maps naturally to a workflow approval pattern in the custom app.

## Recommendations

### Asset Master Data Monitoring & Cleanup Platform (BTP Extension)

#### Executive Summary

Custom CAP app with React UI, scheduled monitoring, and S/4HANA write-back via OData API.

#### Recommended Solution

Build a CAP Node.js backend on SAP BTP with a React (SAP UI5 Web Components) frontend that:
1. Connects to S/4HANA Cloud Private Edition via the Fixed Asset Master Data OData API (`CE_FIXEDASSET_0001`) to retrieve and evaluate asset records
2. Provides a **Rule Builder** UI where authorised users configure sensitive fields, threshold periods (e.g. 90 days), and evaluation logic (empty-field checks)
3. Runs a **scheduled monitoring job** that scans all asset records against active rules and flags violations
4. Sends **email alerts** to Asset Accountants summarising newly flagged records
5. Presents a **review dashboard** where Asset Accountants mark each flagged asset with a recommended action: Block, Delete, or Keep
6. Routes flagged items through a **Finance Manager approval step** within the platform
7. On approval, calls the S/4HANA OData APIs (`CE_FIXEDASSETRETIREMENT_0001` for deletion, `FIXEDASSETCHANGE` for block flag update) to write actions back automatically
8. Supports **mass selection and mass action** from the dashboard

#### Problem Statement

Asset master data in S/4HANA accumulates stale, incomplete, or meaningless records over time with no automated detection or remediation path, creating data quality debt and compliance risk.

#### Affected User Roles

- **Asset Accountant** — reviews flagged records, proposes block/delete/keep actions
- **Finance Manager** — approves proposed actions and triggers write-back to S/4HANA
- **Platform Administrator** — configures monitoring rules, sensitive fields, and alert schedules

#### Important factors

##### Reduces manual data quality effort
Currently, no mechanism exists to automatically identify uncapitalized or stale assets — all review is ad hoc and manual. This platform automates detection and reduces the review cycle significantly.

##### Configurable by design
Rules and thresholds are user-managed in the UI, so the platform adapts as business needs change without requiring code changes.

##### Direct S/4HANA write-back eliminates dual keying
Approved actions flow automatically into SAP — no export/import or manual re-entry required.

#### Potential risks

##### API scope for block flag updates
The standard `CE_FIXEDASSET_0001` change API must support updating the XLOEV (deletion flag) field — this needs to be validated against the actual API schema during development.

##### Scheduled job timing vs. data volume
For large asset portfolios, the monitoring scan job may need pagination and batching to stay within API rate limits.

#### Recommended solution category

CAP App

#### Intent fit
88%
