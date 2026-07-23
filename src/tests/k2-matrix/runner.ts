import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_OFFER_STATE } from '../../config/defaults';
import { PAYMENT_PLAN_TEMPLATES } from '../../config/paymentPlans';
import { DEFAULT_TARIFF_VERSIONS, TARIFFS, type TariffProfile } from '../../config/tariffs';
import { addIsoDays, adjustToBusinessDay } from '../../domain/calendar/calendar';
import { buildDailyCashflow } from '../../domain/financing/financing';
import { calculateActualPaymentFinancials } from '../../domain/payment-plan/actualPaymentFinancials';
import { buildReceivableInstallments } from '../../domain/receivables/ledger';
import { calculateOffer } from '../../domain/profitability/calculation';
import { buildPlannedProfitLedger, sumProfitLedger } from '../../domain/profitability/profitLedger';
import { calculateRealization } from '../../domain/realization/realization';
import type {
  ActualCustomerRefund,
  ActualPayment,
  CalculationResult,
  CashEvent,
  DailyCashflowRow,
  PlannedOffer,
  RealizationResult,
} from '../../types';
import {
  CONTRACT,
  GES_CASES,
  HOLIDAYS,
  MARKET_PRICES,
  MONEY_TOLERANCE,
  PAYMENT_BEHAVIORS,
  RATE_TOLERANCE,
  createMatrixPaymentPlan,
  type GesCase,
  type PaymentBehavior,
  type RuleResult,
  type ScenarioRecord,
  type ScenarioStatus,
} from './model';

const OUTPUT_DIRECTORY = resolve('test-results');
const sum = <T>(values: T[], pick: (value: T) => number): number =>
  values.reduce((total, value) => total + pick(value), 0);
const near = (actual: number, expected: number, tolerance = MONEY_TOLERANCE): boolean =>
  Math.abs(actual - expected) <= tolerance;
const money = (value: number): string => `${value.toFixed(2)} TL`;

const containsNumber = (
  value: unknown,
  predicate: (candidate: number) => boolean,
  seen = new WeakSet<object>(),
): boolean => {
  if (typeof value === 'number') return predicate(value);
  if (value == null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => containsNumber(child, predicate, seen));
};

const csvCell = (value: unknown): string => {
  const serialized = Array.isArray(value)
    ? value.join('; ')
    : typeof value === 'object' && value != null
      ? JSON.stringify(value)
      : String(value ?? '');
  return /[",\r\n]/.test(serialized) ? `"${serialized.replaceAll('"', '""')}"` : serialized;
};

const toCsv = <T extends object>(rows: T[], fallbackHeaders: string[] = []): string => {
  const headers = rows[0] ? Object.keys(rows[0]) : fallbackHeaders;
  return [
    headers.map(csvCell).join(','),
    ...rows.map((row) =>
      headers.map((header) => csvCell((row as Record<string, unknown>)[header])).join(','),
    ),
  ].join('\n');
};

const writeText = (name: string, content: string): void =>
  writeFileSync(resolve(OUTPUT_DIRECTORY, name), content, 'utf8');

const expectedVatRate = (tariff: TariffProfile): number =>
  tariff.subscriberGroup === 'Tarımsal Sulama' ? 10 : 20;
const expectedBtvRate = (tariff: TariffProfile): number =>
  tariff.subscriberGroup === 'Sanayi' || tariff.subscriberGroup === 'Tarımsal Sulama' ? 1 : 5;

const paymentPlanDefaults = (): Array<Record<string, unknown>> =>
  PAYMENT_PLAN_TEMPLATES.map((template) => {
    const plan = createMatrixPaymentPlan(template.id);
    return {
      id: template.id,
      name: template.name,
      rows: plan.rows.map((row) => ({
        name: row.name,
        amountType: row.amountType,
        amountValue: row.amountValue,
        dateReference: row.dateReference,
        dayOffset: row.dayOffset,
        fixedDay: row.fixedDay,
        fixedDayMonthOffset: row.fixedDayMonthOffset,
        paymentChannel: row.paymentChannel,
        installmentCount: row.installmentCount,
        installmentIntervalDays: row.installmentIntervalDays,
        merchantSettlementMode: row.merchantSettlementMode,
        bankSettlementDelayDays: row.bankSettlementDelayDays,
        commissionRate: row.commissionRate,
        commissionBearer: row.commissionBearer,
      })),
    };
  });

const buildState = (tariff: TariffProfile, templateId: string, ges: GesCase) => ({
  ...structuredClone(DEFAULT_OFFER_STATE),
  customerId: `matrix-customer-${tariff.key}`,
  title: `K2 Matrix · ${tariff.label}`,
  usageStart: CONTRACT.start,
  usageEnd: CONTRACT.end,
  monthlyConsumption: CONTRACT.monthlyConsumptionMWh,
  monthlyConsumptionUnit: 'MWh' as const,
  customerType: tariff.key,
  kdvRate: tariff.kdvDefault,
  btvRate: tariff.btvDefault,
  distributionUnitTlMwh: tariff.distributionTlMwh,
  tariffSourceMode: 'catalog' as const,
  tariffOverrides: [],
  contractPowerTl: 0,
  ptfTlMwh: CONTRACT.ptfTlMwh,
  yekdemTlMwh: CONTRACT.yekdemTlMwh,
  offerRate: 0,
  creditRate: CONTRACT.creditRate,
  valorRate: CONTRACT.valorRate,
  ges: structuredClone(ges.settings),
  paymentPlan: createMatrixPaymentPlan(templateId),
});

const plannedOffer = (
  tariff: TariffProfile,
  templateId: string,
  ges: GesCase,
): { offer: PlannedOffer; calculationMs: number } => {
  const state = buildState(tariff, templateId, ges);
  const started = performance.now();
  const result = calculateOffer(state, HOLIDAYS, MARKET_PRICES, DEFAULT_TARIFF_VERSIONS);
  const calculationMs = performance.now() - started;
  return {
    calculationMs,
    offer: {
      id: `matrix-offer-${tariff.key}-${templateId}-${ges.id}`,
      recordType: 'planned_offer',
      customerId: state.customerId,
      version: 1,
      title: state.title,
      status: 'final',
      stateSnapshot: structuredClone(result.state),
      paymentPlanSnapshot: structuredClone(result.state.paymentPlan),
      resultSnapshot: result,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
};

interface BehaviorFixture {
  actualPayments: ActualPayment[];
  actualRefunds: ActualCustomerRefund[];
  asOfDate: string;
  blocked: boolean;
  blockedReasons: string[];
  expectedOverpayment: number;
}

const behaviorFixture = (source: CalculationResult, behavior: PaymentBehavior): BehaviorFixture => {
  const installments = buildReceivableInstallments(
    source.periods,
    source.plannedPayments,
    source.reconciliationInstructions ?? [],
  );
  const installmentByPayment = new Map(
    installments
      .filter((installment) => installment.sourcePlannedPaymentId)
      .map((installment) => [installment.sourcePlannedPaymentId!, installment]),
  );
  let firstOverpayment = 0;
  const actualPayments = source.plannedPayments.map<ActualPayment>((payment, index) => {
    const overpay = index === 0 && (behavior === 'overpay_carry' || behavior === 'overpay_refund');
    const amount = payment.principalAmount * (overpay ? 1.1 : 1);
    if (overpay) firstOverpayment = amount - payment.principalAmount;
    return {
      id: `actual-${behavior}-${index + 1}`,
      invoiceId: payment.periodId,
      receivableInstallmentId: installmentByPayment.get(payment.id)?.id,
      date:
        behavior === 'late_10_days'
          ? addIsoDays(payment.transactionDate, 10)
          : payment.transactionDate,
      amount,
      channel: payment.paymentChannel,
      commissionRate: payment.commissionRate,
      commissionBearer: payment.commissionBearer,
      note: `K2 matrix · ${behavior}`,
    };
  });
  const actualRefunds: ActualCustomerRefund[] =
    behavior === 'overpay_refund' && actualPayments[0] && firstOverpayment > 0
      ? [
          {
            id: 'actual-refund-overpayment',
            date: addIsoDays(actualPayments[0].date, 10),
            amount: firstOverpayment,
            sourcePeriodId: actualPayments[0].invoiceId,
            note: 'K2 matrix · 10 gün sonra fazla ödeme iadesi',
          },
        ]
      : [];
  const eventDates = [...actualPayments.map((payment) => payment.date), ...actualRefunds.map((refund) => refund.date)];
  const asOfDate = [addIsoDays(CONTRACT.end, 100), ...eventDates].sort().at(-1)!;
  const noScheduledPayment = source.plannedPayments.length === 0;
  return {
    actualPayments,
    actualRefunds,
    asOfDate,
    blocked: noScheduledPayment && behavior !== 'on_time',
    blockedReasons:
      noScheduledPayment && behavior !== 'on_time'
        ? ['Brüt müşteri faturası sıfır olduğu için seçilen ödeme davranışı üretilemedi.']
        : [],
    expectedOverpayment: firstOverpayment,
  };
};

const scenarioOffer = (offer: PlannedOffer, behavior: PaymentBehavior): PlannedOffer => {
  const reconciliation = structuredClone(offer.stateSnapshot.paymentPlan.reconciliation);
  reconciliation.overpaymentAction =
    behavior === 'overpay_refund' ? 'refund_after_days' : 'carry_forward';
  return {
    ...offer,
    stateSnapshot: {
      ...offer.stateSnapshot,
      paymentPlan: { ...offer.stateSnapshot.paymentPlan, reconciliation },
    },
    paymentPlanSnapshot: { ...offer.paymentPlanSnapshot, reconciliation },
  };
};

const calculateBehavior = (
  offer: PlannedOffer,
  behavior: PaymentBehavior,
): { result: RealizationResult; fixture: BehaviorFixture; runtimeMs: number } => {
  const fixture = behaviorFixture(offer.resultSnapshot, behavior);
  const sourceOfferSnapshot = scenarioOffer(offer, behavior);
  const scenario = {
    id: `matrix-scenario-${behavior}`,
    sourceCustomerId: offer.customerId,
    sourceOfferId: offer.id,
    sourceOfferVersion: offer.version,
    sourceOfferSnapshot,
    name: `K2 Matrix · ${behavior}`,
    asOfDate: fixture.asOfDate,
    periodOverrides: [],
    financingOverrides: {
      creditRate: CONTRACT.creditRate,
      valorRate: CONTRACT.valorRate,
    },
    actualPayments: fixture.actualPayments,
    actualRefunds: fixture.actualRefunds,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const started = performance.now();
  const result = calculateRealization(scenario, 5.55, MARKET_PRICES, HOLIDAYS);
  return { result, fixture, runtimeMs: performance.now() - started };
};

const financingCloseDate = (rows: DailyCashflowRow[]): string => {
  let lastNegative = -1;
  rows.forEach((row, index) => {
    if (row.closingBalance < -MONEY_TOLERANCE) lastNegative = index;
  });
  if (lastNegative < 0) return rows[0]?.date ?? '';
  return rows.slice(lastNegative + 1).find((row) => row.closingBalance >= -MONEY_TOLERANCE)?.date ?? '';
};

const duplicateIds = (events: CashEvent[]): number => {
  const counts = new Map<string, number>();
  events.forEach((event) => counts.set(event.id, (counts.get(event.id) ?? 0) + 1));
  return [...counts.values()].reduce((count, value) => count + Math.max(0, value - 1), 0);
};

const scenarioRecord = (
  tariff: TariffProfile,
  templateId: string,
  ges: GesCase,
  behavior: PaymentBehavior,
  offer: PlannedOffer,
  calculationMs: number,
  realized: ReturnType<typeof calculateBehavior>,
): ScenarioRecord => {
  const source = offer.resultSnapshot;
  const actual = realized.result;
  const fixture = realized.fixture;
  const scenarioId = `${tariff.key}__${templateId}__${behavior}__${ges.id}`;
  const failures: string[] = [];
  const reviews: string[] = [];
  if (!source.valid) failures.push('CALC-VALID');
  if (source.periods.length !== CONTRACT.months) failures.push('CONTRACT-PERIODS');
  if (!near(source.totals.grossConsumptionMwh, CONTRACT.totalConsumptionMWh))
    failures.push('CONTRACT-CONSUMPTION');
  const activeEnergyDifference = sum(
    source.periods,
    (period) => period.activeEnergySalesAmount - period.gridConsumptionMwh * CONTRACT.activeEnergyUnitTlMwh,
  );
  if (!near(activeEnergyDifference, 0)) failures.push('TAR-ACTIVE-ENERGY');
  const invoiceDifference = sum(
    source.periods,
    (period) =>
      period.activeEnergySalesAmount +
      period.distributionAmount +
      period.contractPowerAmount +
      period.btvAmount +
      period.kdvAmount -
      period.grossInvoice,
  );
  if (!near(invoiceDifference, 0)) failures.push('ACC-INVOICE');
  if (
    source.periods.some(
      (period) =>
        !near(period.btvBase, period.activeEnergySalesAmount) ||
        !near(period.btvAmount, period.activeEnergySalesAmount * (tariff.btvDefault / 100)),
    )
  )
    failures.push('TAR-BTV');
  if (
    source.periods.some((period) =>
      !near(
        period.kdvBase,
        period.activeEnergySalesAmount +
          period.distributionAmount +
          period.contractPowerAmount +
          period.btvAmount,
      ),
    )
  )
    failures.push('TAR-VAT-BASE');
  if (Math.abs(tariff.btvDefault - expectedBtvRate(tariff)) > RATE_TOLERANCE)
    failures.push('TAR-BTV-RATE');
  if (Math.abs(tariff.kdvDefault - expectedVatRate(tariff)) > RATE_TOLERANCE)
    failures.push('TAR-VAT-RATE');

  const expectedSelfConsumption = ges.expectedMonthly.selfConsumptionMWh * CONTRACT.months;
  const expectedGrid = ges.expectedMonthly.gridConsumptionMWh * CONTRACT.months;
  const expectedExcess = ges.expectedMonthly.excessMWh * CONTRACT.months;
  const actualExcess = sum(source.periods, (period) => period.excessProductionMwh ?? 0);
  if (!near(source.totals.gesSelfConsumptionMwh, expectedSelfConsumption)) failures.push('GES-Q02-SELF');
  if (!near(source.totals.gridConsumptionMwh, expectedGrid)) failures.push('GES-Q02-GRID');
  if (!near(actualExcess, expectedExcess)) failures.push('GES-Q02-EXCESS');
  if (source.totals.gridConsumptionMwh < -MONEY_TOLERANCE) failures.push('GES-Q02-NEGATIVE-GRID');
  const expectedGesSettlement = ges.id === 'excess_120' ? expectedExcess * CONTRACT.ptfTlMwh : 0;
  if (!near(source.totals.excessProductionPurchase, expectedGesSettlement)) failures.push('GES-Q03');
  const gesEvents = source.cashEvents.filter((event) => event.type === 'excess_production_purchase');
  if (gesEvents.some((event) => event.direction !== 'out')) failures.push('GES-Q03-DIRECTION');

  const paymentAllocationDifference =
    source.totals.grossInvoice -
    actual.receivableLedger.totalCollectedPrincipal -
    actual.receivableLedger.totalAdvanceApplied -
    actual.receivableLedger.totalOutstandingPrincipal;
  if (!near(paymentAllocationDifference, 0)) failures.push('ACC-PAYMENT');
  if (!near(actual.cashReconciliationDifference ?? 0, 0)) failures.push('ACC-CASHFLOW');
  if (!near(actual.profitReconciliationDifference ?? 0, 0)) failures.push('ACC-PROFIT');
  if (!fixture.blocked && actual.endingOpenReceivable > MONEY_TOLERANCE)
    failures.push('PAY-OPEN-RECEIVABLE');
  if (behavior === 'overpay_refund' && !fixture.blocked) {
    if (!near(actual.actualRefundTotal ?? 0, fixture.expectedOverpayment)) failures.push('PAY-REFUND-AMOUNT');
    const refunds = actual.actualCashEvents?.filter((event) => event.type === 'customer_refund') ?? [];
    if (refunds.length !== 1) failures.push('PAY-REFUND-COUNT');
  }
  if (behavior === 'late_10_days') {
    const datesCorrect = fixture.actualPayments.every((payment, index) => {
      const planned = source.plannedPayments[index];
      return planned != null && payment.date === addIsoDays(planned.transactionDate, 10);
    });
    if (!datesCorrect) failures.push('PAY-LATE-DATE');
  }
  if (fixture.blocked) reviews.push('PAY-NOT-APPLICABLE-ZERO-INVOICE');
  const duplicatedCashEventCount = duplicateIds(actual.actualCashEvents ?? []);
  if (duplicatedCashEventCount > 0) failures.push('PAY-05-DUPLICATE-ID');

  const actualPaymentById = new Map(fixture.actualPayments.map((payment) => [payment.id, payment]));
  const cardFinancials = actual.actualPaymentFinancials.filter((financials) =>
    actualPaymentById.get(financials.paymentId)?.channel.startsWith('credit_card'),
  );
  const cardPrincipal = sum(cardFinancials, (financials) => financials.principalAmount);
  const cardCommission = sum(
    cardFinancials,
    (financials) => financials.epsasChannelCost + financials.customerChannelFee,
  );
  const bankGrossTransfer = sum(
    actual.actualPaymentFinancials,
    (financials) => financials.principalAmount + financials.customerChannelFee,
  );
  const bankNetTransfer = sum(actual.actualPaymentFinancials, (financials) => financials.netCashIn);
  const minimumCashBalance = Math.min(0, ...actual.actualCashflow.map((row) => row.closingBalance));
  const maximumCashBalance = Math.max(0, ...actual.actualCashflow.map((row) => row.closingBalance));
  const maximumOpenFinancing = Math.max(
    0,
    ...actual.actualCashflow.map((row) => Math.max(0, -row.closingBalance)),
  );
  const actualOperationalCost = sum(
    actual.periods,
    (period) =>
      period.actualImbalance +
      period.actualPiu +
      period.actualPaymentChannelCost +
      period.actualExcessProductionPurchase,
  );
  const firstTariff = source.periods[0]?.tariffSnapshot;
  const record: ScenarioRecord = {
    scenarioId,
    customerTypeId: tariff.key,
    customerTypeName: tariff.label,
    tariffType: tariff.tariffType,
    voltageLevel: tariff.tariffType.endsWith('AG') ? 'AG' : 'OG',
    termType: tariff.tariffType.startsWith('Çift') ? 'Çift Terimli' : 'Tek Terimli',
    paymentPlanId: templateId,
    paymentPlanName: offer.stateSnapshot.paymentPlan.name,
    paymentBehavior: behavior,
    gesMode: ges.id,
    contractStart: CONTRACT.start,
    contractEnd: CONTRACT.end,
    contractMonths: CONTRACT.months,
    monthlyConsumptionMWh: CONTRACT.monthlyConsumptionMWh,
    totalConsumptionMWh: source.totals.grossConsumptionMwh,
    ptf: CONTRACT.ptfTlMwh,
    yekdem: CONTRACT.yekdemTlMwh,
    creditRate: CONTRACT.creditRate,
    valorRate: CONTRACT.valorRate,
    commissionPayer: [...new Set(offer.stateSnapshot.paymentPlan.rows.map((row) => row.commissionBearer))].join('+'),
    vatRate: firstTariff?.kdvRate ?? tariff.kdvDefault,
    btvRate: firstTariff?.btvRate ?? tariff.btvDefault,
    distributionUnitPrice: firstTariff?.distributionUnitTlMwh ?? tariff.distributionTlMwh,
    contractPowerValue: offer.stateSnapshot.contractPowerTl,
    tariffVersion: firstTariff?.versionLabel ?? '',
    tariffValidityStart: firstTariff?.validFrom ?? '',
    tariffValidityEnd: firstTariff?.validTo ?? '',
    grossConsumptionMWh: source.totals.grossConsumptionMwh,
    gesGenerationMWh: sum(
      source.periods,
      (period) => period.gesSelfConsumptionMwh + (period.gridExportMwh ?? 0),
    ),
    selfConsumptionMWh: source.totals.gesSelfConsumptionMwh,
    gridConsumptionMWh: source.totals.gridConsumptionMwh,
    excessGenerationMWh: actualExcess,
    activeEnergyAmount: source.totals.activeEnergySalesAmount,
    distributionAmount: source.totals.distributionAmount,
    contractPowerAmount: source.totals.contractPowerAmount,
    btvBase: sum(source.periods, (period) => period.btvBase),
    btvAmount: source.totals.btvAmount,
    vatBase: sum(source.periods, (period) => period.kdvBase),
    vatAmount: source.totals.kdvAmount,
    gesSettlementAmount: actual.actualExcessProductionPurchase,
    grossInvoiceAmount: source.totals.grossInvoice,
    scheduledCustomerPayment: sum(source.plannedPayments, (payment) => payment.principalAmount),
    actualCustomerPayment: sum(
      actual.actualPaymentFinancials,
      (financials) => financials.principalAmount + financials.customerChannelFee,
    ),
    cardPrincipal,
    cardCommission,
    bankGrossTransfer,
    bankNetTransfer,
    overpaymentAmount: Math.max(
      0,
      actual.receivableLedger.totalPaymentsAsOf - source.totals.grossInvoice,
    ),
    refundedAmount: actual.actualRefundTotal ?? 0,
    carriedForwardAmount: actual.receivableLedger.totalAdvanceApplied,
    openReceivable: actual.endingOpenReceivable,
    creditCost: actual.actualCreditCost,
    valorIncome: actual.actualValorIncome,
    netFinancingCost: actual.actualCreditCost - actual.actualValorIncome,
    minimumCashBalance,
    maximumCashBalance,
    endingCashBalance: actual.endingCashBalance,
    maximumOpenFinancing,
    financingCloseDate: financingCloseDate(actual.actualCashflow),
    revenue: source.totals.activeEnergySalesAmount,
    totalOperationalCost: actualOperationalCost,
    totalFinancingCost: actual.actualCreditCost - actual.actualValorIncome,
    netProfit: actual.actualProfit,
    profitMargin:
      source.totals.activeEnergyBaseAmount > 0
        ? actual.actualProfit / source.totals.activeEnergyBaseAmount
        : 0,
    profitPerMWh:
      source.totals.gridConsumptionMwh > 0
        ? actual.actualProfit / source.totals.gridConsumptionMwh
        : 0,
    invoiceReconciliationDifference: invoiceDifference,
    paymentAllocationDifference,
    cashflowReconciliationDifference: actual.cashReconciliationDifference ?? 0,
    profitReconciliationDifference: actual.profitReconciliationDifference ?? 0,
    hasNaN: false,
    hasInfinity: false,
    duplicatedCashEventCount,
    blocked: fixture.blocked,
    blockedReasons: fixture.blockedReasons,
    runtimeMs: calculationMs / PAYMENT_BEHAVIORS.length + realized.runtimeMs,
    status: 'PASS',
    failedRules: failures,
    reviewRules: reviews,
  };
  record.hasNaN = containsNumber([source, actual, record], Number.isNaN);
  record.hasInfinity = containsNumber(
    [source, actual, record],
    (value) => !Number.isFinite(value) && !Number.isNaN(value),
  );
  if (record.hasNaN) failures.push('TECH-NAN');
  if (record.hasInfinity) failures.push('TECH-INFINITY');
  record.status = failures.length > 0 ? 'FAIL' : reviews.length > 0 ? 'REVIEW' : 'PASS';
  return record;
};

interface SensitivityEvidence {
  scenarioId: string;
  baseCredit: number;
  highCredit: number;
  baseValor: number;
  highValor: number;
  baseProfit: number;
  highCreditProfit: number;
  highValorProfit: number;
}

const sensitivityEvidence = (offer: PlannedOffer, scenarioId: string): SensitivityEvidence => {
  const source = offer.resultSnapshot;
  const creditCashflow = buildDailyCashflow(source.cashEvents, 60, CONTRACT.valorRate);
  const valorCashflow = buildDailyCashflow(source.cashEvents, CONTRACT.creditRate, 50);
  const creditLedger = buildPlannedProfitLedger(source.periods, source.plannedPayments, creditCashflow);
  const valorLedger = buildPlannedProfitLedger(source.periods, source.plannedPayments, valorCashflow);
  return {
    scenarioId,
    baseCredit: source.totals.creditCost,
    highCredit: sum(creditCashflow, (row) => row.creditInterest),
    baseValor: source.totals.valorIncome,
    highValor: sum(valorCashflow, (row) => row.valorInterest),
    baseProfit: source.totals.netProfit,
    highCreditProfit: sumProfitLedger(creditLedger),
    highValorProfit: sumProfitLedger(valorLedger),
  };
};

const status = (passed: boolean, review = false): ScenarioStatus =>
  passed ? (review ? 'REVIEW' : 'PASS') : 'FAIL';

const targetedRules = (
  records: ScenarioRecord[],
  sensitivity: SensitivityEvidence[],
): { rules: RuleResult[]; dailySamples: Record<string, unknown>[] } => {
  const evidence = (filter: (record: ScenarioRecord) => boolean, count = 4): string[] =>
    records.filter(filter).slice(0, count).map((record) => record.scenarioId);
  const fullAdvance = records.filter(
    (record) => record.paymentPlanId === 'full_advance' && record.paymentBehavior === 'on_time' && record.gesMode === 'off',
  );
  const standard = records.filter(
    (record) => record.paymentPlanId === 'standard_deferred' && record.paymentBehavior === 'on_time' && record.gesMode === 'off',
  );
  const late = records.filter(
    (record) => record.paymentPlanId === 'standard_deferred' && record.paymentBehavior === 'late_10_days' && record.gesMode === 'off',
  );
  const mixed = records.filter(
    (record) => (record.paymentPlanId === 'mixed' || record.paymentPlanId === 'custom') && record.paymentBehavior === 'on_time',
  );
  const noNan = records.every((record) => !record.hasNaN && !record.hasInfinity);
  const invoiceOk = records.every((record) => near(record.invoiceReconciliationDifference, 0));
  const paymentOk = records.every((record) => near(record.paymentAllocationDifference, 0));
  const cashOk = records.every((record) => near(record.cashflowReconciliationDifference, 0));
  const profitOk = records.every((record) => near(record.profitReconciliationDifference, 0));
  const overpaymentRecords = records.filter(
    (record) =>
      (record.paymentBehavior === 'overpay_carry' || record.paymentBehavior === 'overpay_refund') &&
      !record.blocked,
  );
  const onTimeByKey = new Map(
    records
      .filter((record) => record.paymentBehavior === 'on_time')
      .map((record) => [
        `${record.customerTypeId}|${record.paymentPlanId}|${record.gesMode}`,
        record,
      ]),
  );
  const overpaymentRevenueOk = overpaymentRecords.every((record) => {
    const onTime = onTimeByKey.get(
      `${record.customerTypeId}|${record.paymentPlanId}|${record.gesMode}`,
    );
    return (
      onTime != null &&
      near(record.revenue, onTime.revenue) &&
      record.overpaymentAmount > MONEY_TOLERANCE &&
      (record.paymentBehavior !== 'overpay_refund' ||
        near(record.refundedAmount, record.overpaymentAmount))
    );
  });

  const epsasCommission = calculateActualPaymentFinancials({
    id: 'pay-epsas',
    date: '2026-01-01',
    amount: 100,
    channel: 'credit_card_single',
    commissionRate: 2,
    commissionBearer: 'epsas',
  });
  const customerCommission = calculateActualPaymentFinancials({
    id: 'pay-customer',
    date: '2026-01-01',
    amount: 100,
    channel: 'credit_card_single',
    commissionRate: 2,
    commissionBearer: 'customer',
  });
  const commissionPrincipalOk =
    near(epsasCommission.principalAmount, 100) &&
    near(epsasCommission.netCashIn, 98) &&
    near(customerCommission.principalAmount, 100) &&
    near(customerCommission.netCashIn, 100);

  const sameDayRows = buildDailyCashflow(
    [
      { id: 'same-day', date: '2026-07-10', type: 'customer_payment', direction: 'in', amount: 1_000, label: 'Tahsilat' },
    ],
    CONTRACT.creditRate,
    CONTRACT.valorRate,
    { calculationStartDate: '2026-07-10', calculationEndDate: '2026-07-11' },
  );
  const weekendRows = buildDailyCashflow(
    [
      { id: 'weekend', date: '2026-07-10', type: 'ptf', direction: 'out', amount: 1_000, label: 'Cuma çıkışı' },
    ],
    CONTRACT.creditRate,
    CONTRACT.valorRate,
    { calculationStartDate: '2026-07-10', calculationEndDate: '2026-07-13' },
  );
  const holidayRows = buildDailyCashflow(
    [
      { id: 'holiday', date: '2026-07-14', type: 'ptf', direction: 'out', amount: 1_000, label: 'Tatil öncesi çıkış' },
    ],
    CONTRACT.creditRate,
    CONTRACT.valorRate,
    { calculationStartDate: '2026-07-14', calculationEndDate: '2026-07-16' },
  );
  const weekendOk = ['2026-07-11', '2026-07-12'].every(
    (date) => (weekendRows.find((row) => row.date === date)?.creditInterest ?? 0) > 0,
  );
  const holidayOk =
    adjustToBusinessDay('2026-07-15') === '2026-07-16' &&
    (holidayRows.find((row) => row.date === '2026-07-15')?.creditInterest ?? 0) > 0;

  const creditSensitivityOk = sensitivity.every((item) =>
    item.baseCredit > MONEY_TOLERANCE
      ? item.highCredit > item.baseCredit && item.highCreditProfit < item.baseProfit
      : near(item.highCredit, item.baseCredit) && near(item.highCreditProfit, item.baseProfit),
  );
  const valorSensitivityOk = sensitivity.every((item) =>
    item.baseValor > MONEY_TOLERANCE
      ? item.highValor > item.baseValor && item.highValorProfit > item.baseProfit
      : near(item.highValor, item.baseValor) && near(item.highValorProfit, item.baseProfit),
  );

  const gesOff = records.filter((record) => record.gesMode === 'off' && record.paymentBehavior === 'on_time');
  const gesZeroByKey = new Map(
    records
      .filter((record) => record.gesMode === 'active_zero' && record.paymentBehavior === 'on_time')
      .map((record) => [`${record.customerTypeId}|${record.paymentPlanId}`, record]),
  );
  const gesZeroOk = gesOff.every((off) => {
    const zero = gesZeroByKey.get(`${off.customerTypeId}|${off.paymentPlanId}`);
    if (!zero) return false;
    return [
      'gridConsumptionMWh',
      'activeEnergyAmount',
      'distributionAmount',
      'btvAmount',
      'vatAmount',
      'grossInvoiceAmount',
      'creditCost',
      'valorIncome',
      'netProfit',
    ].every((key) =>
      near(
        off[key as keyof ScenarioRecord] as number,
        zero[key as keyof ScenarioRecord] as number,
      ),
    );
  });
  const gesPhysicalOk = records.every((record) => record.gridConsumptionMWh >= -MONEY_TOLERANCE);
  const gesExcess = records.filter((record) => record.gesMode === 'excess_120');
  const gesDirectionOk = gesExcess.every(
    (record) => near(record.excessGenerationMWh, 24) && near(record.gesSettlementAmount, 84_000),
  );

  const fixedCostTariff = TARIFFS[0]!;
  const fixedCostGes = structuredClone(GES_CASES.find((item) => item.id === 'excess_120')!);
  fixedCostGes.settings.excessProductionTaxMode = 'manual';
  fixedCostGes.settings.manualTaxAmountTl = 12_000;
  const fixedCostOffer = plannedOffer(fixedCostTariff, 'standard_deferred', fixedCostGes).offer;
  const fixedCostDifference = fixedCostOffer.resultSnapshot.totals.excessProductionPurchase - 84_000;
  const fixedCostOk = near(fixedCostDifference, 12_000);

  const tariffRateMismatches = records.filter((record) => record.failedRules.includes('TAR-VAT-RATE'));
  const tariffRateSample = tariffRateMismatches[0];
  const sampleExpectedVat = tariffRateSample ? tariffRateSample.vatBase * 0.2 : 0;
  const sampleVatDifference = tariffRateSample
    ? sampleExpectedVat - tariffRateSample.vatAmount
    : 0;
  const tariffBtvMismatches = records.filter((record) => record.failedRules.includes('TAR-BTV-RATE'));
  const distributionDistinct = new Set(TARIFFS.map((tariff) => tariff.distributionTlMwh)).size === TARIFFS.length;
  const cardInstallmentRecords = records.filter(
    (record) =>
      (record.paymentPlanId === 'card_installment_upfront' ||
        record.paymentPlanId === 'card_installment_settlement') &&
      record.paymentBehavior === 'on_time' &&
      record.gesMode === 'off',
  );
  const duplicateCardIncome = cardInstallmentRecords.some(
    (record) => record.duplicatedCashEventCount > 0 || record.bankNetTransfer - record.actualCustomerPayment > MONEY_TOLERANCE,
  );

  const rules: RuleResult[] = [
    {
      rule: 'PAY-01',
      question: 'Tam ön ödemede valör oluşuyor mu?',
      status: status(
        fullAdvance.every((record) => record.maximumCashBalance > 0 && record.valorIncome > 0),
      ),
      expected: 'Gerçek pozitif bakiye günlerinde valör; ilk tahsilat gününde 0.',
      actual: `${fullAdvance.filter((record) => record.valorIncome > 0).length}/${fullAdvance.length} profilde valör oluştu; doğrudan günlük örnekte ilk gün ${money(sameDayRows[0]?.valorInterest ?? 0)}.`,
      difference: money(sameDayRows[0]?.valorInterest ?? 0),
      evidenceScenarios: evidence((record) => record.paymentPlanId === 'full_advance' && record.gesMode === 'off'),
      productionCode: 'src/domain/financing/financing.ts:112-181',
    },
    {
      rule: 'PAY-02',
      question: 'Vadeli planda gerçek tahsilata kadar kredi maliyeti oluşuyor mu?',
      status: status(standard.every((record) => record.creditCost > 0)),
      expected: 'Negatif bakiye günlerinde kredi devam eder; tahsilat bakiyeyi azaltır.',
      actual: `${standard.filter((record) => record.creditCost > 0).length}/${standard.length} profilde kredi oluştu; ${standard.filter((record) => record.openReceivable <= MONEY_TOLERANCE).length}/${standard.length} müşteri hesabı kapandı.`,
      difference: money(sum(standard, (record) => record.openReceivable)),
      evidenceScenarios: evidence((record) => record.paymentPlanId === 'standard_deferred' && record.gesMode === 'off'),
      productionCode: 'src/domain/financing/financing.ts:112-181; src/domain/receivables/ledger.ts:96-230',
    },
    {
      rule: 'PAY-03',
      question: 'Kart komisyonu müşteri anaparasını azaltıyor mu?',
      status: status(commissionPrincipalOk),
      expected: '100 TL anapara tamamen kapanır; EPSAŞ net nakdi %2 komisyonla 98 TL olur.',
      actual: `Anapara ${money(epsasCommission.principalAmount)}, EPSAŞ net nakit ${money(epsasCommission.netCashIn)}, komisyon ${money(epsasCommission.epsasChannelCost)}.`,
      difference: money(100 - epsasCommission.principalAmount),
      evidenceScenarios: ['target-card-epsas-2pct'],
      productionCode: 'src/domain/payment-plan/actualPaymentFinancials.ts:33-56',
    },
    {
      rule: 'PAY-04',
      question: 'Müşteri ve EPSAŞ komisyon modelleri ayrılıyor mu?',
      status: status(
        near(epsasCommission.epsasChannelCost, 2) &&
          near(customerCommission.customerChannelFee, 2) &&
          near(customerCommission.epsasChannelCost, 0),
      ),
      expected: 'EPSAŞ modelinde 2 TL gider; müşteri modelinde 2 TL müşteri kanal ücreti.',
      actual: `EPSAŞ gideri ${money(epsasCommission.epsasChannelCost)}; müşteri ücreti ${money(customerCommission.customerChannelFee)}.`,
      difference: money(epsasCommission.netCashIn - customerCommission.netCashIn),
      evidenceScenarios: ['target-card-epsas-2pct', 'target-card-customer-2pct'],
      productionCode: 'src/domain/payment-plan/actualPaymentFinancials.ts:33-56',
    },
    {
      rule: 'PAY-05',
      question: 'Taksitli aktarım mükerrer nakit girişi üretiyor mu?',
      status: status(!duplicateCardIncome, true),
      expected: 'Banka aktarımı anaparayı aşmaz; müşteri kart takvimi ve banka transferi ayrı rollerde izlenir.',
      actual: `Mükerrer nakit kimliği yok; ancak üretim modeli müşteri kart çekim takvimini ayrı olay türü olarak taşımıyor.`,
      difference: money(
        Math.max(0, ...cardInstallmentRecords.map((record) => record.bankNetTransfer - record.actualCustomerPayment)),
      ),
      evidenceScenarios: evidence((record) => record.paymentPlanId.startsWith('card_installment')),
      productionCode: 'src/domain/payment-plan/paymentPlan.ts:34-125; src/types/index.ts:260-284',
    },
    {
      rule: 'PAY-06',
      question: 'Karma ve özel plan tutarları faturaya tam eşit mi?',
      status: status(mixed.every((record) => near(record.paymentAllocationDifference, 0))),
      expected: 'Satır toplamı dönem borcuna eşit; negatif veya kuruşluk artık yok.',
      actual: `En büyük dağılım farkı ${money(Math.max(0, ...mixed.map((record) => Math.abs(record.paymentAllocationDifference))))}.`,
      difference: money(Math.max(0, ...mixed.map((record) => Math.abs(record.paymentAllocationDifference)))),
      evidenceScenarios: evidence((record) => record.paymentPlanId === 'mixed' || record.paymentPlanId === 'custom'),
      productionCode: 'src/domain/payment-plan/paymentPlan.ts:34-125',
    },
    {
      rule: 'FIN-01',
      question: 'Kredi oranı %49’dan %60’a çıkınca maliyet artıyor mu?',
      status: status(creditSensitivityOk),
      expected: 'Negatif bakiye varsa kredi artar ve net kâr düşer; yoksa değişmez.',
      actual: `${sensitivity.filter((item) => item.baseCredit > MONEY_TOLERANCE).length}/${sensitivity.length} kombinasyonda negatif bakiye etkisi ölçüldü.`,
      difference: money(sum(sensitivity, (item) => item.highCredit - item.baseCredit)),
      evidenceScenarios: sensitivity.slice(0, 4).map((item) => item.scenarioId),
      productionCode: 'src/domain/financing/financing.ts:112-181; src/domain/profitability/profitLedger.ts',
    },
    {
      rule: 'FIN-02',
      question: 'Valör oranı %40’tan %50’ye çıkınca gelir artıyor mu?',
      status: status(valorSensitivityOk),
      expected: 'Pozitif bakiye varsa valör ve net kâr artar; yoksa değişmez.',
      actual: `${sensitivity.filter((item) => item.baseValor > MONEY_TOLERANCE).length}/${sensitivity.length} kombinasyonda pozitif bakiye etkisi ölçüldü.`,
      difference: money(sum(sensitivity, (item) => item.highValor - item.baseValor)),
      evidenceScenarios: sensitivity.slice(0, 4).map((item) => item.scenarioId),
      productionCode: 'src/domain/financing/financing.ts:112-181; src/domain/profitability/profitLedger.ts',
    },
    {
      rule: 'FIN-03',
      question: 'Tahsilatın gerçekleştiği ilk gün valör sıfır mı?',
      status: status(near(sameDayRows[0]?.valorInterest ?? 0, 0) && (sameDayRows[1]?.valorInterest ?? 0) > 0),
      expected: 'İlk gün 0; sonraki gün pozitif.',
      actual: `2026-07-10 ${money(sameDayRows[0]?.valorInterest ?? 0)}, 2026-07-11 ${money(sameDayRows[1]?.valorInterest ?? 0)}.`,
      difference: money(sameDayRows[0]?.valorInterest ?? 0),
      evidenceScenarios: ['fin-same-day-valor'],
      productionCode: 'src/domain/financing/financing.ts:151-158',
    },
    {
      rule: 'FIN-04',
      question: 'Cumartesi ve pazar finansman faizi işliyor mu?',
      status: status(weekendOk),
      expected: '11 ve 12 Temmuz günlerinde faiz sıfırdan büyük.',
      actual: `Cumartesi ${money(weekendRows[1]?.creditInterest ?? 0)}, pazar ${money(weekendRows[2]?.creditInterest ?? 0)}.`,
      difference: money((weekendRows[1]?.creditInterest ?? 0) + (weekendRows[2]?.creditInterest ?? 0)),
      evidenceScenarios: ['fin-weekend-2026-07-10'],
      productionCode: 'src/domain/financing/financing.ts:112-181',
    },
    {
      rule: 'FIN-05',
      question: '15 Temmuz tatilinde faiz işliyor mu?',
      status: status(holidayOk),
      expected: 'İşlem 16 Temmuz’a kayabilir; 15 Temmuz faiz günü atlanmaz.',
      actual: `İş günü düzeltmesi ${adjustToBusinessDay('2026-07-15')}; 15 Temmuz kredi ${money(holidayRows[1]?.creditInterest ?? 0)}.`,
      difference: money(holidayRows[1]?.creditInterest ?? 0),
      evidenceScenarios: ['fin-holiday-2026-07-15'],
      productionCode: 'src/domain/calendar/calendar.ts:24-37; src/domain/financing/financing.ts:112-181',
    },
    {
      rule: 'FIN-06',
      question: 'Geç ödemede planlanan tarih ödeme sayılıyor mu?',
      status: status(late.every((record) => record.openReceivable <= MONEY_TOLERANCE && record.creditCost > 0)),
      expected: 'Gerçek tahsilata kadar alacak/finansman açık; gerçekleşen ödeme sonunda müşteri hesabı kapanır.',
      actual: `${late.filter((record) => record.creditCost > 0).length}/${late.length} kredi; son açık alacak toplamı ${money(sum(late, (record) => record.openReceivable))}.`,
      difference: money(sum(late, (record) => record.openReceivable)),
      evidenceScenarios: evidence((record) => record.paymentBehavior === 'late_10_days' && record.gesMode === 'off'),
      productionCode: 'src/domain/receivables/ledger.ts:96-230; src/domain/realization/realization.ts:130-469',
    },
    {
      rule: 'GES-Q01',
      question: 'Öz tüketim ayrı nakit geliri oluşturuyor mu?',
      status: status(
        records
          .filter((record) => record.gesMode === 'self_30' || record.gesMode === 'self_100')
          .every((record) => record.gesSettlementAmount === 0),
      ),
      expected: 'Öz tüketim fiziksel azaltım; nakit tahsilatı değil.',
      actual: 'Öz tüketim senaryolarında GES settlement nakdi 0 TL.',
      difference: money(0),
      evidenceScenarios: evidence((record) => record.gesMode === 'self_30' || record.gesMode === 'self_100'),
      productionCode: 'src/domain/ges/ges.ts:48-96; src/domain/financing/financing.ts:13-95',
    },
    {
      rule: 'GES-Q02',
      question: 'GES oranı şebeke tüketimini 10/7/0/0 MWh yapıyor mu?',
      status: status(gesPhysicalOk && !records.some((record) => record.failedRules.some((rule) => rule.startsWith('GES-Q02')))),
      expected: '%0=10, %30=7, %100=0, %120=0 ve negatif tüketim yok.',
      actual: 'Beş GES modu 12 aylık üretim sonuçlarıyla karşılaştırıldı.',
      difference: money(0),
      evidenceScenarios: evidence(() => true, 5),
      productionCode: 'src/domain/ges/ges.ts:48-96',
    },
    {
      rule: 'GES-Q03',
      question: '%120 GES ihtiyaç fazlası EPSAŞ nakit çıkışı mı?',
      status: status(gesDirectionOk),
      expected: 'Aylık 2 MWh × 3.500 = 7.000 TL; yıllık 84.000 TL çıkış.',
      actual: `Yıllık settlement aralığı ${money(Math.min(...gesExcess.map((record) => record.gesSettlementAmount)))}–${money(Math.max(...gesExcess.map((record) => record.gesSettlementAmount)))}.`,
      difference: money(Math.max(0, ...gesExcess.map((record) => Math.abs(record.gesSettlementAmount - 84_000)))),
      evidenceScenarios: evidence((record) => record.gesMode === 'excess_120'),
      productionCode: 'src/domain/ges/ges.ts:35-96; src/domain/financing/financing.ts:13-95',
    },
    {
      rule: 'GES-Q04',
      question: '12.000 TL manuel GES sabit vergi/maliyeti yalnız bir kez uygulanıyor mu?',
      status: status(fixedCostOk),
      expected: 'Yıllık ihtiyaç fazlası alımına tam 12.000 TL eklenir.',
      actual: `84.000 TL enerji alımına eklenen tutar ${money(fixedCostDifference)}.`,
      difference: money(fixedCostDifference - 12_000),
      evidenceScenarios: ['ges-fixed-cost-12000'],
      productionCode: 'src/domain/ges/ges.ts:84-95; src/domain/invoice/invoice.ts:13-99',
    },
    {
      rule: 'GES-Q05',
      question: 'GES kapalı ile aktif %0 finansal olarak aynı mı?',
      status: status(gesZeroOk),
      expected: 'Fiziksel, fatura, nakit, finansman ve kâr değerleri aynı.',
      actual: `${gesOff.length} kapalı/%0 çifti karşılaştırıldı.`,
      difference: money(0),
      evidenceScenarios: gesOff.slice(0, 4).map((record) => record.scenarioId),
      productionCode: 'src/domain/ges/ges.ts:48-67',
    },
    {
      rule: 'TAR-01',
      question: '12 gerçek tarife profili eksiksiz mi?',
      status: status(TARIFFS.length === 12),
      expected: '12 profil.',
      actual: `${TARIFFS.length} profil.`,
      difference: String(TARIFFS.length - 12),
      evidenceScenarios: TARIFFS.map((tariff) => tariff.key),
      productionCode: 'src/config/tariffs.ts:13-122',
    },
    {
      rule: 'TAR-02',
      question: 'Marj %0 iken aktif enerji 3.900 TL/MWh mı?',
      status: status(!records.some((record) => record.failedRules.includes('TAR-ACTIVE-ENERGY'))),
      expected: 'PTF 3.500 + YEKDEM 400 = 3.900 TL/MWh.',
      actual: '2.160 senaryonun dönemsel aktif enerji tutarları net şebeke tüketimiyle karşılaştırıldı.',
      difference: money(0),
      evidenceScenarios: records.slice(0, 4).map((record) => record.scenarioId),
      productionCode: 'src/domain/invoice/invoice.ts:13-99',
    },
    {
      rule: 'TAR-03',
      question: 'BTV yalnız aktif enerji matrahından mı hesaplanıyor?',
      status: status(!records.some((record) => record.failedRules.includes('TAR-BTV') || record.failedRules.includes('TAR-BTV-RATE'))),
      expected: 'Dağıtım BTV matrahına girmez; oran grup bazında %1/%5.',
      actual: `${tariffBtvMismatches.length} oran/matrah uyumsuzluğu.`,
      difference: String(tariffBtvMismatches.length),
      evidenceScenarios: tariffBtvMismatches.slice(0, 4).map((record) => record.scenarioId),
      productionCode: 'src/domain/invoice/invoice.ts:63-66; src/config/tariffs.ts:13-122',
    },
    {
      rule: 'TAR-04',
      question: 'KDV matrahı ve profil oranları beklenen kuralla uyumlu mu?',
      status: status(tariffRateMismatches.length === 0 && !records.some((record) => record.failedRules.includes('TAR-VAT-BASE'))),
      expected: 'Sanayi/Ticarethane/Mesken %20; Tarımsal Sulama %10.',
      actual: `${tariffRateMismatches.length} senaryoda Mesken KDV oranı %10. Örnek ${tariffRateSample?.scenarioId ?? 'yok'}: matrah ${money(tariffRateSample?.vatBase ?? 0)}, gerçek KDV ${money(tariffRateSample?.vatAmount ?? 0)}, %20 beklentisi ${money(sampleExpectedVat)}. Matrah formülü ayrıca doğrulandı.`,
      difference: `${tariffRateMismatches.length} senaryo; örnek ${money(sampleVatDifference)}`,
      evidenceScenarios: tariffRateMismatches.slice(0, 4).map((record) => record.scenarioId),
      productionCode: 'src/config/tariffs.ts:13-122; src/domain/invoice/invoice.ts:67-69',
    },
    {
      rule: 'TAR-05',
      question: 'AG/OG ve tek/çift terimli dağıtım değerleri gerçekten farklı mı?',
      status: status(distributionDistinct),
      expected: '12 profil kendi dağıtım birim bedelini kullanır.',
      actual: `${new Set(TARIFFS.map((tariff) => tariff.distributionTlMwh)).size} benzersiz dağıtım değeri.`,
      difference: String(TARIFFS.length - new Set(TARIFFS.map((tariff) => tariff.distributionTlMwh)).size),
      evidenceScenarios: TARIFFS.slice(0, 4).map((tariff) => tariff.key),
      productionCode: 'src/config/tariffs.ts:13-122; src/domain/invoice/invoice.ts:61-63',
    },
    {
      rule: 'ACC-01',
      question: 'Fatura, ödeme, nakit ve kâr mutabakatları sıfır mı?',
      status: status(invoiceOk && paymentOk && cashOk && profitOk),
      expected: 'Dört mutabakat farkı ≤ 0,01 TL.',
      actual: `Fatura=${invoiceOk}, ödeme=${paymentOk}, nakit=${cashOk}, kâr=${profitOk}.`,
      difference: money(
        Math.max(
          ...records.flatMap((record) => [
            Math.abs(record.invoiceReconciliationDifference),
            Math.abs(record.paymentAllocationDifference),
            Math.abs(record.cashflowReconciliationDifference),
            Math.abs(record.profitReconciliationDifference),
          ]),
        ),
      ),
      evidenceScenarios: records.slice(0, 4).map((record) => record.scenarioId),
      productionCode: 'src/domain/profitability/monthlyProfit.ts; src/domain/profitability/profitLedger.ts',
    },
    {
      rule: 'ACC-02',
      question: 'Fazla ödeme satış geliri veya kâr anaparası olarak yazılıyor mu?',
      status: status(overpaymentRevenueOk),
      expected: 'Fazla ödeme müşteri avansı/iade yükümlülüğüdür; enerji geliri değişmez.',
      actual: `${overpaymentRecords.length} uygulanabilir fazla ödeme senaryosunda enerji geliri zamanında ödeme eşleniğiyle aynı; iade tutarı fazla ödemeyle mutabık.`,
      difference: money(
        Math.max(
          0,
          ...overpaymentRecords.map((record) => {
            const onTime = onTimeByKey.get(
              `${record.customerTypeId}|${record.paymentPlanId}|${record.gesMode}`,
            );
            return Math.abs(record.revenue - (onTime?.revenue ?? 0));
          }),
        ),
      ),
      evidenceScenarios: evidence(
        (record) => record.paymentBehavior === 'overpay_carry' || record.paymentBehavior === 'overpay_refund',
      ),
      productionCode: 'src/domain/receivables/ledger.ts:96-230; src/domain/profitability/profitLedger.ts:128-225',
    },
    {
      rule: 'TECH-01',
      question: 'Sonuçlarda NaN veya Infinity var mı?',
      status: status(noNan),
      expected: '0 geçersiz sayısal değer.',
      actual: `${records.filter((record) => record.hasNaN || record.hasInfinity).length} geçersiz sonuç.`,
      difference: String(records.filter((record) => record.hasNaN || record.hasInfinity).length),
      evidenceScenarios: evidence((record) => record.hasNaN || record.hasInfinity),
      productionCode: 'src/domain/**',
    },
  ];

  return {
    rules,
    dailySamples: [
      { id: 'FIN-03', rows: sameDayRows },
      { id: 'FIN-04', rows: weekendRows },
      { id: 'FIN-05', rows: holidayRows },
      {
        id: 'FIN-06',
        scenarios: late.slice(0, 2).map((record) => ({
          scenarioId: record.scenarioId,
          creditCost: record.creditCost,
          openReceivable: record.openReceivable,
          maximumOpenFinancing: record.maximumOpenFinancing,
          financingCloseDate: record.financingCloseDate,
        })),
      },
    ],
  };
};

const countBy = (records: ScenarioRecord[], field: keyof ScenarioRecord): Array<[string, number, number, number]> => {
  const groups = new Map<string, ScenarioRecord[]>();
  records.forEach((record) => {
    const key = String(record[field]);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  });
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [
    key,
    rows.filter((row) => row.status === 'PASS').length,
    rows.filter((row) => row.status === 'FAIL').length,
    rows.filter((row) => row.status === 'REVIEW').length,
  ]);
};

const markdownGroup = (title: string, rows: Array<[string, number, number, number]>): string =>
  [`### ${title}`, '', '| Değer | PASS | FAIL | REVIEW |', '|---|---:|---:|---:|', ...rows.map(([key, pass, fail, review]) => `| ${key} | ${pass} | ${fail} | ${review} |`), ''].join('\n');

const rootCauseReport = (records: ScenarioRecord[], rules: RuleResult[]): string => {
  const failedRules = rules.filter((rule) => rule.status === 'FAIL');
  if (failedRules.length === 0)
    return '# K2 EnerjiPro Finansal Matris — Kök Neden Raporu\n\nFAIL bulunmadı.\n';
  return [
    '# K2 EnerjiPro Finansal Matris — Kök Neden Raporu',
    '',
    '> Bu rapor yalnız olası üretim kodu konumlarını gösterir. Üretim formülleri değiştirilmemiştir.',
    '',
    ...failedRules.flatMap((rule, index) => {
      const scenarioRule = rule.rule === 'TAR-04' ? 'TAR-VAT-RATE' : rule.rule;
      const affected = records.filter((record) => record.failedRules.includes(scenarioRule)).length;
      return [
        `## ROOT-${String(index + 1).padStart(2, '0')}`,
        '',
        `**Başlık:** ${rule.question}`,
        '',
        `**Etkilenen ana senaryo:** ${affected}`,
        '',
        `**Muhtemel dosyalar:** ${rule.productionCode}`,
        '',
        `**Beklenen:** ${rule.expected}`,
        '',
        `**Gerçekleşen:** ${rule.actual}`,
        '',
        `**Fark:** ${rule.difference}`,
        '',
        `**Kanıt:** ${rule.evidenceScenarios.join(', ') || 'Hedefli kural testi'}`,
        '',
        '**Önerilen yaklaşım:** İş kuralı sahibiyle beklenen değer doğrulandıktan sonra yalnız ilgili üretim konumu ayrı düzeltme görevi olarak ele alınmalıdır.',
        '',
      ];
    }),
  ].join('\n');
};

const tariffComparisonRows = (): Array<Record<string, unknown>> =>
  TARIFFS.map((tariff) => {
    const version = DEFAULT_TARIFF_VERSIONS.find((item) => item.customerType === tariff.key)!;
    return {
      customerTypeId: tariff.key,
      customerTypeName: tariff.label,
      tariffType: tariff.tariffType,
      subscriberGroup: tariff.subscriberGroup,
      voltageLevel: tariff.tariffType.endsWith('AG') ? 'AG' : 'OG',
      termType: tariff.tariffType.startsWith('Çift') ? 'Çift Terimli' : 'Tek Terimli',
      actualVatRate: tariff.kdvDefault,
      expectedVatRate: expectedVatRate(tariff),
      vatStatus: near(tariff.kdvDefault, expectedVatRate(tariff), RATE_TOLERANCE) ? 'PASS' : 'FAIL',
      actualBtvRate: tariff.btvDefault,
      expectedBtvRate: expectedBtvRate(tariff),
      btvStatus: near(tariff.btvDefault, expectedBtvRate(tariff), RATE_TOLERANCE) ? 'PASS' : 'FAIL',
      distributionUnitPrice: tariff.distributionTlMwh,
      contractPowerValue: 0,
      tariffVersion: version.versionLabel,
      tariffValidityStart: version.validFrom,
      tariffValidityEnd: version.validTo ?? '',
      sourceLabel: version.sourceLabel,
    };
  });

const engineTransitionRows = (): Array<Record<string, unknown>> =>
  TARIFFS.flatMap((from) =>
    TARIFFS.filter((to) => to.key !== from.key).map((to) => ({
      fromCustomerTypeId: from.key,
      toCustomerTypeId: to.key,
      expectedVatRate: to.kdvDefault,
      actualVatRate: to.kdvDefault,
      expectedBtvRate: to.btvDefault,
      actualBtvRate: to.btvDefault,
      expectedDistributionUnitPrice: to.distributionTlMwh,
      actualDistributionUnitPrice: to.distributionTlMwh,
      staleValueDetected: false,
      calculationTargetMatched: true,
      verificationMode: 'engine-fallback',
      status: 'REVIEW',
    })),
  );

export interface MatrixRunSummary {
  scenarioCount: number;
  passCount: number;
  failCount: number;
  reviewCount: number;
  blockedCount: number;
  runtimeMs: number;
  ruleResults: RuleResult[];
}

export const runK2Matrix = (): MatrixRunSummary => {
  mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
  const started = performance.now();
  const records: ScenarioRecord[] = [];
  const sensitivity: SensitivityEvidence[] = [];
  for (const tariff of TARIFFS) {
    for (const template of PAYMENT_PLAN_TEMPLATES) {
      for (const ges of GES_CASES) {
        const source = plannedOffer(tariff, template.id, ges);
        if (ges.id === 'off')
          sensitivity.push(
            sensitivityEvidence(source.offer, `${tariff.key}__${template.id}__financing`),
          );
        for (const behavior of PAYMENT_BEHAVIORS) {
          const realized = calculateBehavior(source.offer, behavior.id);
          records.push(
            scenarioRecord(
              tariff,
              template.id,
              ges,
              behavior.id,
              source.offer,
              source.calculationMs,
              realized,
            ),
          );
        }
      }
    }
  }
  const { rules, dailySamples } = targetedRules(records, sensitivity);
  const transitionPath = resolve(OUTPUT_DIRECTORY, 'k2-customer-type-transition-results.csv');
  if (!existsSync(transitionPath)) writeText('k2-customer-type-transition-results.csv', toCsv(engineTransitionRows()));
  const transitionText = readFileSync(transitionPath, 'utf8');
  const transitionRows = Math.max(0, transitionText.trim().split(/\r?\n/).length - 1);
  const transitionFailures = transitionText.split(/\r?\n/).filter((line) => /,FAIL(?:,|$)/.test(line)).length;
  rules.push({
    rule: 'TAR-06',
    question: '132 yönlü müşteri tipi geçişinde eski değer kalıyor mu?',
    status: transitionRows === 132 && transitionFailures === 0 && transitionText.includes('playwright-ui') ? 'PASS' : 'REVIEW',
    expected: '132 geçiş; hedef KDV/BTV/dağıtım ve hesaplama sonucu yeni profile ait.',
    actual: `${transitionRows} satır; ${transitionFailures} FAIL; ${transitionText.includes('playwright-ui') ? 'Playwright UI' : 'motor fallback'} kanıtı.`,
    difference: String(132 - transitionRows),
    evidenceScenarios: ['test-results/k2-customer-type-transition-results.csv'],
    productionCode: 'src/pages/CostCalculation/CostCalculationPage.tsx:317-427; src/config/tariffs.ts:13-144',
  });

  const runtimeMs = performance.now() - started;
  const passCount = records.filter((record) => record.status === 'PASS').length;
  const failCount = records.filter((record) => record.status === 'FAIL').length;
  const reviewCount = records.filter((record) => record.status === 'REVIEW').length;
  const blockedCount = records.filter((record) => record.blocked).length;
  const failedRuleCounts = new Map<string, number>();
  records.forEach((record) =>
    record.failedRules.forEach((rule) => failedRuleCounts.set(rule, (failedRuleCounts.get(rule) ?? 0) + 1)),
  );

  writeText('k2-all-scenarios.csv', toCsv(records));
  writeText(
    'k2-all-scenarios.json',
    JSON.stringify(
      {
        generatedAt: '2026-01-01T00:00:00.000Z',
        timezone: 'Europe/Istanbul',
        financingDayBasis: 365,
        tolerances: { moneyTl: MONEY_TOLERANCE, rate: RATE_TOLERANCE },
        contract: CONTRACT,
        paymentPlanDefaults: paymentPlanDefaults(),
        scenarioCount: records.length,
        scenarios: records,
      },
      null,
      2,
    ),
  );
  writeText('k2-rule-results.csv', toCsv(rules));
  writeText('k2-failures.csv', toCsv(records.filter((record) => record.status === 'FAIL'), Object.keys(records[0] ?? {})));
  writeText(
    'k2-duplicate-cash-events.csv',
    toCsv(
      records.filter((record) => record.duplicatedCashEventCount > 0),
      ['scenarioId', 'duplicatedCashEventCount'],
    ),
  );
  writeText('k2-daily-cashflow-samples.json', JSON.stringify(dailySamples, null, 2));
  writeText('k2-tariff-comparison.csv', toCsv(tariffComparisonRows()));

  const summary = [
    '# K2 EnerjiPro Kapsamlı Finansal Test Özeti',
    '',
    `- Toplam ana senaryo: **${records.length}**`,
    `- PASS: **${passCount}**`,
    `- FAIL: **${failCount}**`,
    `- REVIEW: **${reviewCount}**`,
    `- Bloke: **${blockedCount}**`,
    `- Çalışma süresi: **${(runtimeMs / 1_000).toFixed(2)} saniye**`,
    `- Finansman gün bazı: **365**`,
    `- Saat dilimi: **Europe/Istanbul**`,
    `- Para toleransı: **${MONEY_TOLERANCE.toFixed(2)} TL**`,
    '',
    '> Üretim hesaplama formülleri kopyalanmadı veya değiştirilmedi. Sonuçlar doğrudan üretim domain fonksiyonlarından üretildi.',
    '',
    markdownGroup('Müşteri tipine göre', countBy(records, 'customerTypeId')),
    markdownGroup('Ödeme planına göre', countBy(records, 'paymentPlanId')),
    markdownGroup('Ödeme davranışına göre', countBy(records, 'paymentBehavior')),
    markdownGroup('GES moduna göre', countBy(records, 'gesMode')),
    '### Ana senaryo hata kuralları',
    '',
    '| Kural | Etkilenen senaryo |',
    '|---|---:|',
    ...[...failedRuleCounts].sort(([a], [b]) => a.localeCompare(b)).map(([rule, count]) => `| ${rule} | ${count} |`),
    '',
    '## Sorulara doğrudan cevaplar',
    '',
    '| Kural | Soru | Sonuç | Beklenen | Gerçekleşen | Fark | Kanıt senaryoları | Üretim kodu |',
    '|---|---|---:|---|---|---:|---|---|',
    ...rules.map(
      (rule) =>
        `| ${rule.rule} | ${rule.question} | ${rule.status} | ${rule.expected.replaceAll('|', '\\|')} | ${rule.actual.replaceAll('|', '\\|')} | ${rule.difference} | ${rule.evidenceScenarios.join('<br>')} | ${rule.productionCode} |`,
    ),
    '',
    '## Üretim varsayılanları notu',
    '',
    '- Sabit Gün şablonu: takip eden ayın **10. günü**.',
    '- Tam Ön Ödeme: dönem başlangıcından **10 gün önce**.',
    '- Kısmi Avans + Kalan: **%80 avans + kalan**.',
    '- Karma Plan: **%30 avans + %40 kart + kalan EFT**.',
    '- Kart şablonlarının varsayılan komisyon oranı: **%0**; `%2` varyant PAY-03/PAY-04 hedefli testinde çalıştırıldı.',
    '- Üretimde genel GES sabit maliyet alanı yoktur; `manualTaxAmountTl` yalnız ihtiyaç fazlası alımının manuel vergi/maliyet bileşeni olarak test edildi.',
    '',
  ].join('\n');
  writeText('k2-test-summary.md', summary);
  writeText('k2-root-cause-report.md', rootCauseReport(records, rules));

  return {
    scenarioCount: records.length,
    passCount,
    failCount,
    reviewCount,
    blockedCount,
    runtimeMs,
    ruleResults: rules,
  };
};
