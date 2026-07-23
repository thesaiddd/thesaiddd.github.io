import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_OFFER_STATE } from '../src/config/defaults';
import { applyTariffDefaults, TARIFFS } from '../src/config/tariffs';
import { getDemoDataset } from '../src/demo/demoDataset';
import { calculateOffer } from '../src/domain/profitability/calculation';

const outputPath = resolve('test-results', 'k2-customer-type-transition-results.csv');

const csvCell = (value: unknown): string => {
  const serialized = String(value ?? '');
  return /[",\r\n]/.test(serialized) ? `"${serialized.replaceAll('"', '""')}"` : serialized;
};

const resetApplication = async (page: Page): Promise<void> => {
  await page.goto('/');
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((done) => {
      const request = indexedDB.deleteDatabase('k2-energipro-3');
      request.onsuccess = () => done();
      request.onerror = () => done();
      request.onblocked = () => done();
    });
  });
  await page.reload();
};

const loadDemoData = async (page: Page): Promise<void> => {
  await page.getByRole('link', { name: 'Ayarlar' }).click();
  await page.getByRole('button', { name: 'Demo verisi yükle' }).click();
  await page.getByRole('button', { name: 'Uyarıyı kabul et ve yükle' }).click();
  await expect(page.getByText('Kontrollü demo verisi yüklendi')).toBeVisible();
};

const parseTurkishNumber = (value: string | null): number =>
  Number((value ?? '').replace(/[^\d,.-]/g, '').replaceAll('.', '').replace(',', '.'));

const directedTransitionTrail = (): string[] => {
  const remaining = new Map(
    TARIFFS.map((tariff) => [
      tariff.key,
      TARIFFS.filter((candidate) => candidate.key !== tariff.key).map((candidate) => candidate.key),
    ]),
  );
  const stack = [TARIFFS[0]!.key];
  const circuit: string[] = [];
  while (stack.length > 0) {
    const current = stack.at(-1)!;
    const next = remaining.get(current)?.shift();
    if (next) stack.push(next);
    else circuit.push(stack.pop()!);
  }
  return circuit.reverse();
};

test('12 profil arasındaki 132 yönlü geçiş hedef tarife ve hesaplama sonucunu yeniler', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await resetApplication(page);
  await loadDemoData(page);
  await page.getByRole('link', { name: 'Maliyet Hesaplama' }).click();
  await page.getByLabel('Çalışma başlığı').fill('');
  await page.getByRole('button', { name: 'Gelişmiş ölçüm' }).click();
  await page.getByLabel('Ölçüm / mahsup').selectOption('hourly');
  await page.getByRole('button', { name: 'Maliyet Tarife ve finansman' }).click();
  await expect(page.getByRole('heading', { name: 'Maliyet girdileri' })).toBeVisible();
  await page.getByRole('button', { name: 'Başabaş Maliyet sonucu' }).click();
  await expect(page.getByText('Hesaplama tamamlanamadı.')).toBeVisible();
  await page.getByRole('button', { name: 'Maliyet Tarife ve finansman' }).click();

  const dataset = getDemoDataset();
  const settings = dataset.settings[0]!;
  const expectedBreakEven = new Map(
    TARIFFS.map((tariff) => {
      const result = calculateOffer(
        {
          ...structuredClone(DEFAULT_OFFER_STATE),
          ...applyTariffDefaults(tariff.key),
          usageStart: '2026-07-01',
          usageEnd: '2026-07-31',
          monthlyConsumption: 10,
          offerRate: 0,
        },
        settings.holidays,
        settings.monthlyMarketPrices,
        settings.tariffVersions,
      );
      return [tariff.key, result.totals.breakevenOfferRate] as const;
    }),
  );

  const customerType = page.getByLabel('Müşteri tipi');
  const tariffByKey = new Map(TARIFFS.map((tariff) => [tariff.key, tariff]));
  const trail = directedTransitionTrail();
  const observedRows = await page.evaluate(async (transitionTrail) => {
    const labelByText = (text: string): HTMLLabelElement | undefined =>
      [...document.querySelectorAll<HTMLLabelElement>('label')].find(
        (label) => label.querySelector(':scope > span')?.textContent?.trim() === text,
      );
    const select = labelByText('Müşteri tipi')?.querySelector('select');
    const vat = labelByText('KDV')?.querySelector('input');
    const btv = labelByText('BTV')?.querySelector('input');
    const distribution = labelByText('Dağıtım')?.querySelector('input');
    const tariffTable = document.querySelector<HTMLTableElement>(
      'table[aria-label="Dönemsel tarife kaynakları"]',
    );
    if (!select || !vat || !btv || !distribution || !tariffTable)
      throw new Error('Tarife geçişi için gerekli UI alanları bulunamadı.');
    const choose = async (value: string): Promise<void> => {
      select.value = value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise<void>((done) => requestAnimationFrame(() => done()));
    };
    const observed: Array<{
      fromCustomerTypeId: string;
      toCustomerTypeId: string;
      actualVatRate: number;
      actualBtvRate: number;
      actualDistributionUnitPrice: number;
      tariffSourceText: string;
    }> = [];
    await choose(transitionTrail[0]!);
    for (let index = 0; index < transitionTrail.length - 1; index += 1) {
      await choose(transitionTrail[index + 1]!);
      observed.push({
        fromCustomerTypeId: transitionTrail[index]!,
        toCustomerTypeId: transitionTrail[index + 1]!,
        actualVatRate: Number(vat.value),
        actualBtvRate: Number(btv.value),
        actualDistributionUnitPrice: Number(distribution.value),
        tariffSourceText: tariffTable.tBodies[0]?.rows[0]?.textContent ?? '',
      });
    }
    return observed;
  }, trail);
  const rows: Array<Record<string, unknown>> = observedRows.map((observed) => {
      const from = tariffByKey.get(observed.fromCustomerTypeId)!;
      const to = tariffByKey.get(observed.toCustomerTypeId)!;
      const expectedTariffText = `%${to.kdvDefault} / %${to.btvDefault} / ${to.distributionTlMwh.toLocaleString(
        'tr-TR',
        { minimumFractionDigits: 3, maximumFractionDigits: 3 },
      )} TL/MWh`;
      const staleValueDetected =
        observed.actualVatRate !== to.kdvDefault ||
        observed.actualBtvRate !== to.btvDefault ||
        Math.abs(observed.actualDistributionUnitPrice - to.distributionTlMwh) > 0.000001 ||
        !observed.tariffSourceText.includes(expectedTariffText);

      return {
        fromCustomerTypeId: from.key,
        toCustomerTypeId: to.key,
        expectedVatRate: to.kdvDefault,
        actualVatRate: observed.actualVatRate,
        expectedBtvRate: to.btvDefault,
        actualBtvRate: observed.actualBtvRate,
        expectedDistributionUnitPrice: to.distributionTlMwh,
        actualDistributionUnitPrice: observed.actualDistributionUnitPrice,
        expectedBreakEvenRate: expectedBreakEven.get(to.key)!,
        actualBreakEvenRate: '',
        staleValueDetected,
        calculationTargetMatched: false,
        verificationMode: 'playwright-ui',
        status: 'REVIEW',
      };
    });

  const actualBreakEven = new Map<string, number>();
  await page.getByRole('button', { name: 'Tüketim Teknik bilgiler', exact: true }).click();
  await page.getByLabel('Aylık tüketim').fill('10');
  await page.getByLabel('Kullanım bitişi').fill('2026-07-31');
  await page.getByRole('button', { name: 'Basit öz tüketim' }).click();
  await page.getByLabel('Çalışma başlığı').fill('K2 UI geçiş matrisi');
  await page.getByRole('button', { name: 'Maliyet Tarife ve finansman' }).click();
  for (const tariff of TARIFFS) {
    await customerType.selectOption(tariff.key);
    await page.getByRole('button', { name: 'Başabaş Maliyet sonucu' }).click();
    actualBreakEven.set(
      tariff.key,
      parseTurkishNumber(
        await page
          .locator('.metric-card')
          .filter({ hasText: 'Tahmini başabaş oranı' })
          .locator('strong')
          .textContent(),
      ),
    );
    await page.getByRole('button', { name: 'Maliyet Tarife ve finansman' }).click();
  }
  for (const row of rows) {
    const target = String(row.toCustomerTypeId);
    const actual = actualBreakEven.get(target)!;
    const matched = Math.abs(actual - Number(row.expectedBreakEvenRate)) <= 0.011;
    row.actualBreakEvenRate = actual;
    row.calculationTargetMatched = matched;
    row.status = !row.staleValueDetected && matched ? 'PASS' : 'FAIL';
  }

  await mkdir(resolve('test-results'), { recursive: true });
  const headers = Object.keys(rows[0]!);
  await writeFile(
    outputPath,
    [
      headers.map(csvCell).join(','),
      ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
    ].join('\n'),
    'utf8',
  );

  expect(rows).toHaveLength(132);
  expect(rows.filter((row) => row.status === 'FAIL')).toEqual([]);
});
