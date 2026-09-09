/**
 * Unit tests for the Rule Engine.
 * These tests exercise evaluateFieldCondition, evaluateRule, evaluateAsset and daysSince
 * without starting a CDS server — pure function tests.
 */

import { evaluateFieldCondition, evaluateRule, evaluateAsset, daysSince } from '../srv/rule-engine.js';

// ---------------------------------------------------------------------------
// Helper: build an asset record with sensible defaults
// ---------------------------------------------------------------------------
function makeAsset(overrides = {}) {
  return {
    CompanyCode: '1000',
    MasterFixedAsset: 'A0000001',
    FixedAsset: '0000',
    FixedAssetDescription: 'Office Chair',
    AssetClass: 'FURN',
    CreationDate: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(), // 120 days old
    AcquisitionValueDate: '2023-01-01',
    AssetCapitalizationDate: '2023-01-15',
    AssetDeactivationDate: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: build a rule with conditions
// ---------------------------------------------------------------------------
function makeRule(overrides = {}) {
  return {
    ID: 'rule-001',
    name: 'Test Rule',
    isActive: true,
    ageDaysThreshold: 90,
    conditions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// daysSince
// ---------------------------------------------------------------------------
describe('daysSince', () => {
  it('returns 0 for null', () => {
    expect(daysSince(null)).toBe(0);
  });

  it('returns approximately correct days for a past date', () => {
    const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(daysSince(d)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// evaluateFieldCondition
// ---------------------------------------------------------------------------
describe('evaluateFieldCondition', () => {
  it('IS_EMPTY: returns true when mapped field is null', () => {
    const asset = makeAsset({ AcquisitionValueDate: null });
    expect(evaluateFieldCondition(asset, { fieldName: 'ZUGDT', conditionType: 'IS_EMPTY' })).toBe(true);
  });

  it('IS_EMPTY: returns false when mapped field has a value', () => {
    const asset = makeAsset({ AcquisitionValueDate: '2022-03-01' });
    expect(evaluateFieldCondition(asset, { fieldName: 'ZUGDT', conditionType: 'IS_EMPTY' })).toBe(false);
  });

  it('IS_NOT_EMPTY: returns true when field has a value', () => {
    const asset = makeAsset({ AssetCapitalizationDate: '2022-05-01' });
    expect(evaluateFieldCondition(asset, { fieldName: 'AKTIV', conditionType: 'IS_NOT_EMPTY' })).toBe(true);
  });

  it('CONTAINS_KEYWORD: returns true for case-insensitive match', () => {
    const asset = makeAsset({ FixedAssetDescription: 'Dummy Test Asset' });
    expect(evaluateFieldCondition(asset, { fieldName: 'FixedAssetDescription', conditionType: 'CONTAINS_KEYWORD', keywordValue: 'dummy' })).toBe(true);
  });

  it('CONTAINS_KEYWORD: returns false when keyword absent', () => {
    const asset = makeAsset({ FixedAssetDescription: 'Office Chair' });
    expect(evaluateFieldCondition(asset, { fieldName: 'FixedAssetDescription', conditionType: 'CONTAINS_KEYWORD', keywordValue: 'dummy' })).toBe(false);
  });

  it('unknown conditionType returns false', () => {
    const asset = makeAsset();
    expect(evaluateFieldCondition(asset, { fieldName: 'ZUGDT', conditionType: 'UNKNOWN' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateRule
// ---------------------------------------------------------------------------
describe('evaluateRule', () => {
  it('not triggered when asset is younger than threshold', () => {
    const asset = makeAsset({
      CreationDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days old
      AcquisitionValueDate: null,
      AssetCapitalizationDate: null,
    });
    const rule = makeRule({
      ageDaysThreshold: 90,
      conditions: [
        { fieldName: 'ZUGDT', conditionType: 'IS_EMPTY' },
        { fieldName: 'AKTIV', conditionType: 'IS_EMPTY' },
      ],
    });
    expect(evaluateRule(asset, rule).triggered).toBe(false);
  });

  it('triggered when asset is older than threshold AND all conditions match', () => {
    const asset = makeAsset({
      AcquisitionValueDate: null,
      AssetCapitalizationDate: null,
    });
    const rule = makeRule({
      ageDaysThreshold: 90,
      conditions: [
        { fieldName: 'ZUGDT', conditionType: 'IS_EMPTY' },
        { fieldName: 'AKTIV', conditionType: 'IS_EMPTY' },
      ],
    });
    const result = evaluateRule(asset, rule);
    expect(result.triggered).toBe(true);
    expect(result.violatedFields).toHaveLength(2);
  });

  it('not triggered when only some conditions match (AND logic)', () => {
    const asset = makeAsset({
      AcquisitionValueDate: null,          // ZUGDT IS_EMPTY → true
      AssetCapitalizationDate: '2022-01-01', // AKTIV IS_EMPTY → false
    });
    const rule = makeRule({
      ageDaysThreshold: 90,
      conditions: [
        { fieldName: 'ZUGDT', conditionType: 'IS_EMPTY' },
        { fieldName: 'AKTIV', conditionType: 'IS_EMPTY' },
      ],
    });
    expect(evaluateRule(asset, rule).triggered).toBe(false);
  });

  it('triggered by CONTAINS_KEYWORD condition', () => {
    const asset = makeAsset({ FixedAssetDescription: 'dummy placeholder' });
    const rule = makeRule({
      ageDaysThreshold: 30,
      conditions: [
        { fieldName: 'FixedAssetDescription', conditionType: 'CONTAINS_KEYWORD', keywordValue: 'dummy' },
      ],
    });
    expect(evaluateRule(asset, rule).triggered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateAsset
// ---------------------------------------------------------------------------
describe('evaluateAsset', () => {
  it('returns empty violations for healthy asset (all dates set)', () => {
    const asset = makeAsset({
      AcquisitionValueDate: '2022-01-01',
      AssetCapitalizationDate: '2022-01-15',
      AssetDeactivationDate: null,
    });
    const rules = [
      makeRule({
        ID: 'r1',
        ageDaysThreshold: 90,
        conditions: [
          { fieldName: 'ZUGDT', conditionType: 'IS_EMPTY' },
          { fieldName: 'AKTIV', conditionType: 'IS_EMPTY' },
        ],
      }),
    ];
    expect(evaluateAsset(asset, rules)).toHaveLength(0);
  });

  it('returns violations when asset violates a rule', () => {
    const asset = makeAsset({
      AcquisitionValueDate: null,
      AssetCapitalizationDate: null,
    });
    const rules = [
      makeRule({
        ID: 'r1',
        ageDaysThreshold: 90,
        conditions: [
          { fieldName: 'ZUGDT', conditionType: 'IS_EMPTY' },
          { fieldName: 'AKTIV', conditionType: 'IS_EMPTY' },
        ],
      }),
    ];
    const violations = evaluateAsset(asset, rules);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule.ID).toBe('r1');
  });

  it('skips inactive rules', () => {
    const asset = makeAsset({ AcquisitionValueDate: null, AssetCapitalizationDate: null });
    const rules = [
      makeRule({ ID: 'r1', isActive: false, conditions: [{ fieldName: 'ZUGDT', conditionType: 'IS_EMPTY' }] }),
    ];
    expect(evaluateAsset(asset, rules)).toHaveLength(0);
  });

  it('asset newer than threshold is not flagged even when fields empty', () => {
    const asset = makeAsset({
      CreationDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days old
      AcquisitionValueDate: null,
      AssetCapitalizationDate: null,
    });
    const rules = [
      makeRule({
        ID: 'r1',
        ageDaysThreshold: 90,
        conditions: [
          { fieldName: 'ZUGDT', conditionType: 'IS_EMPTY' },
          { fieldName: 'AKTIV', conditionType: 'IS_EMPTY' },
        ],
      }),
    ];
    expect(evaluateAsset(asset, rules)).toHaveLength(0);
  });
});
