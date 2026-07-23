import { describe, expect, it } from 'vitest';
import { runK2Matrix } from './k2-matrix/runner';

describe('K2 EnerjiPro kapsamlı finansal matrisi', () => {
  it('2.160 ana senaryoyu ve hedefli kuralları üretim domain fonksiyonlarıyla doğrular', () => {
    const summary = runK2Matrix();
    const failedRules = summary.ruleResults.filter((rule) => rule.status === 'FAIL');

    console.info(
      [
        `K2 matrix: ${summary.scenarioCount} scenario`,
        `${summary.passCount} PASS`,
        `${summary.failCount} FAIL`,
        `${summary.reviewCount} REVIEW`,
        `${summary.blockedCount} blocked`,
        `${(summary.runtimeMs / 1_000).toFixed(2)}s`,
      ].join(' · '),
    );

    expect(summary.scenarioCount).toBe(2_160);
    expect(
      { failedScenarios: summary.failCount, failedRules: failedRules.map((rule) => rule.rule) },
      'Ayrıntılı kanıtlar test-results klasörüne yazıldı.',
    ).toEqual({ failedScenarios: 0, failedRules: [] });
  });
});
