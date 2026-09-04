import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareQuantities, describesSameMeasurement, findNumericConflict, normaliseUnit } from './arithmetic.js';
import type { Quantity } from '../db/schema.js';

const q = (value: number, unit: string | null, subject = 'test'): Quantity =>
  ({ value, unit, subject, metric: null, dataset: null, system: null });
const conflicts = (a: Quantity, b: Quantity) => compareQuantities(a, b) !== undefined;

describe('compareQuantities', () => {
  it('flags values that disagree beyond reported precision', () => {
    // Attention Is All You Need reports both of these for EN-FR.
    assert.equal(conflicts(q(41.8, 'BLEU'), q(41, 'BLEU')), true);
    assert.equal(conflicts(q(91.4, '%'), q(96.1, '%')), true);
  });

  it('ignores differences within the rounding window', () => {
    assert.equal(conflicts(q(41.8, 'BLEU'), q(41.8, 'BLEU')), false);
    assert.equal(conflicts(q(41.8, 'BLEU'), q(41.82, 'BLEU')), false);
    // Reported to the nearest whole number, so 100 and 101 are one unit apart.
    assert.equal(conflicts(q(100, 'params'), q(101, 'params')), false);
  });

  it('ignores differences too small to be a disagreement', () => {
    assert.equal(conflicts(q(0.001, 'loss'), q(0.0011, 'loss')), false);
  });

  it('rejects values whose stated units disagree', () => {
    assert.equal(conflicts(q(41.8, 'BLEU'), q(41, '%')), false);
  });

  it('still compares when units are absent, since metrics like BLEU are unitless', () => {
    assert.equal(conflicts(q(41.8, null), q(41, null)), true);
  });

  it('treats known unit spellings as equivalent', () => {
    assert.equal(conflicts(q(91.4, '%'), q(96.1, 'percent')), true);
    assert.equal(conflicts(q(41.8, 'BLEU score'), q(41, 'bleu')), true);
  });

  it('rejects non-finite values rather than producing NaN comparisons', () => {
    assert.equal(conflicts(q(Number.NaN, 'BLEU'), q(41, 'BLEU')), false);
    assert.equal(conflicts(q(Number.POSITIVE_INFINITY, 'BLEU'), q(41, 'BLEU')), false);
  });
});

describe('normaliseUnit', () => {
  it('is case and whitespace insensitive', () => {
    assert.equal(normaliseUnit('  BLEU  '), 'bleu');
    assert.equal(normaliseUnit('%'), 'percent');
    assert.equal(normaliseUnit(null), null);
  });
});

describe('describesSameMeasurement', () => {
  const m = (metric: string | null, system: string | null, dataset: string | null): Quantity =>
    ({ value: 0, unit: null, subject: 'x', metric, dataset, system });

  it('matches the same metric, system and dataset across phrasings', () => {
    assert.equal(
      describesSameMeasurement(
        m('BLEU', 'Transformer (big)', 'WMT14 EN-FR test'),
        m('bleu', 'Transformer big model', 'English-to-French, WMT 2014 test'),
      ),
      true,
    );
  });

  it('separates different systems', () => {
    assert.equal(
      describesSameMeasurement(
        m('BLEU', 'Transformer (base)', 'WMT14 EN-DE test'),
        m('BLEU', 'Transformer (big)', 'WMT14 EN-DE test'),
      ),
      false,
    );
  });

  it('separates different tasks', () => {
    assert.equal(
      describesSameMeasurement(
        m('BLEU', 'Transformer (big)', 'WMT14 EN-DE test'),
        m('BLEU', 'Transformer (big)', 'WMT14 EN-FR test'),
      ),
      false,
    );
  });

  it('separates dev from test, the mistake that produced most false positives', () => {
    assert.equal(
      describesSameMeasurement(
        m('BLEU', 'Transformer (base)', 'newstest2013 dev'),
        m('BLEU', 'Transformer (base)', 'newstest2014 test'),
      ),
      false,
    );
  });

  it('refuses to match when the labels are too thin to establish sameness', () => {
    assert.equal(describesSameMeasurement(m('BLEU', null, 'WMT14'), m('BLEU', null, 'WMT14')), false);
    assert.equal(describesSameMeasurement(m(null, 'ours', null), m(null, 'ours', null)), false);
  });

  it('refuses when only one side names an evaluation set', () => {
    // An abstract reporting "28.4 BLEU" and "41.8 BLEU" is EN-DE and EN-FR, not a contradiction.
    assert.equal(
      describesSameMeasurement(m('BLEU', 'ours', 'WMT14 EN-FR test'), m('BLEU', 'ours', null)),
      false,
    );
  });

  it('still matches dataset-free quantities such as architecture dimensions', () => {
    assert.equal(describesSameMeasurement(m('d_model', 'Transformer (big)', null), m('d_model', 'Transformer (big)', null)), true);
  });
});

describe('findNumericConflict', () => {
  const bleu = (value: number, system: string, dataset: string): Quantity =>
    ({ value, unit: null, subject: 'BLEU', metric: 'BLEU', system, dataset });

  it('finds the Attention Is All You Need EN-FR discrepancy', () => {
    // Table 2 reports 41.8 for the big model on EN-FR; the prose below it says 41.0.
    const conflict = findNumericConflict(
      bleu(41.8, 'Transformer (big)', 'WMT14 EN-FR test'),
      bleu(41, 'Transformer (big)', 'WMT14 EN-FR test'),
    );
    assert.ok(conflict, 'expected a conflict');
    assert.equal(conflict.a.value, 41.8);
    assert.equal(conflict.b.value, 41);
  });

  it('does not compare across systems even when the values differ', () => {
    assert.equal(
      findNumericConflict(
        bleu(41.8, 'Transformer (big)', 'WMT14 EN-FR test'),
        bleu(38.1, 'Transformer (base)', 'WMT14 EN-FR test'),
      ),
      undefined,
    );
  });

  it('does not compare a dev score against a test score', () => {
    assert.equal(
      findNumericConflict(
        bleu(25.8, 'Transformer (base)', 'newstest2013 dev'),
        bleu(27.3, 'Transformer (base)', 'WMT14 EN-DE test'),
      ),
      undefined,
    );
  });
});
