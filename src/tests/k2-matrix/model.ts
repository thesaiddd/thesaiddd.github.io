import { defaultPaymentRow, createPaymentPlan } from '../../config/paymentPlans';
import type { GesSettings, MonthlyMarketPrice, PaymentPlan, PaymentPlanRow } from '../../types';

export const MONEY_TOLERANCE = 0.01;
export const RATE_TOLERANCE = 0.000001;

export const CONTRACT = {
  start: '2026-01-01',
  end: '2026-12-31',
  months: 12,
  monthlyConsumptionMWh: 10,
  totalConsumptionMWh: 120,
  ptfTlMwh: 3_500,
  yekdemTlMwh: 400,
  activeEnergyUnitTlMwh: 3_900,
  creditRate: 49,
  valorRate: 40,
} as const;

export const CONTRACT_MONTHS = Array.from(
  { length: CONTRACT.months },
  (_, index) => `2026-${String(index + 1).padStart(2, '0')}`,
);

export const MARKET_PRICES: MonthlyMarketPrice[] = CONTRACT_MONTHS.map((month) => ({
  month,
  forecastPtfTlMwh: CONTRACT.ptfTlMwh,
  actualPtfTlMwh: CONTRACT.ptfTlMwh,
  forecastYekdemTlMwh: CONTRACT.yekdemTlMwh,
  actualYekdemTlMwh: CONTRACT.yekdemTlMwh,
  sourceNote: 'K2 deterministik finansal test matrisi',
  actualizedAt: '2027-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}));

export const HOLIDAYS: string[] = [];

export type PaymentBehavior = 'on_time' | 'overpay_carry' | 'overpay_refund' | 'late_10_days';

export const PAYMENT_BEHAVIORS: Array<{ id: PaymentBehavior; name: string }> = [
  { id: 'on_time', name: 'Normal zamanında ödeme' },
  { id: 'overpay_carry', name: 'Fazla ödeme · sonraki faturaya aktarım' },
  { id: 'overpay_refund', name: 'Fazla ödeme · 10 gün sonra iade' },
  { id: 'late_10_days', name: '10 takvim günü geç ödeme' },
];

export type GesCaseId = 'off' | 'active_zero' | 'self_30' | 'self_100' | 'excess_120';

export interface GesCase {
  id: GesCaseId;
  name: string;
  settings: GesSettings;
  expectedMonthly: {
    generationMWh: number;
    selfConsumptionMWh: number;
    gridConsumptionMWh: number;
    excessMWh: number;
  };
}

export const GES_CASES: GesCase[] = [
  {
    id: 'off',
    name: 'GES kapalı',
    settings: {
      mode: 'simple_self_consumption',
      selfConsumptionRate: 0,
      nettingMethod: 'monthly',
      settlementMode: 'cash_outflow',
      excessProductionTaxMode: 'no_tax_in_demo',
      manualTaxAmountTl: 0,
      excessPurchasePaymentOffsetDays: 10,
    },
    expectedMonthly: {
      generationMWh: 0,
      selfConsumptionMWh: 0,
      gridConsumptionMWh: 10,
      excessMWh: 0,
    },
  },
  {
    id: 'active_zero',
    name: 'GES aktif · %0',
    settings: {
      mode: 'simple_self_consumption',
      selfConsumptionRate: 0,
      nettingMethod: 'monthly',
      settlementMode: 'cash_outflow',
      excessProductionTaxMode: 'no_tax_in_demo',
      manualTaxAmountTl: 0,
      excessPurchasePaymentOffsetDays: 10,
    },
    expectedMonthly: {
      generationMWh: 0,
      selfConsumptionMWh: 0,
      gridConsumptionMWh: 10,
      excessMWh: 0,
    },
  },
  {
    id: 'self_30',
    name: 'GES · %30 öz tüketim',
    settings: {
      mode: 'advanced_metering',
      selfConsumptionRate: 30,
      totalProductionMwh: 36,
      simultaneousSelfConsumptionMwh: 36,
      gridImportMwh: 84,
      gridExportMwh: 0,
      excessAfterNettingMwh: 0,
      priceType: 'ptf',
      nettingMethod: 'monthly',
      settlementMode: 'cash_outflow',
      excessProductionTaxMode: 'no_tax_in_demo',
      manualTaxAmountTl: 0,
      excessPurchasePaymentOffsetDays: 10,
    },
    expectedMonthly: {
      generationMWh: 3,
      selfConsumptionMWh: 3,
      gridConsumptionMWh: 7,
      excessMWh: 0,
    },
  },
  {
    id: 'self_100',
    name: 'GES · %100 öz tüketim',
    settings: {
      mode: 'advanced_metering',
      selfConsumptionRate: 100,
      totalProductionMwh: 120,
      simultaneousSelfConsumptionMwh: 120,
      gridImportMwh: 0,
      gridExportMwh: 0,
      excessAfterNettingMwh: 0,
      priceType: 'ptf',
      nettingMethod: 'monthly',
      settlementMode: 'cash_outflow',
      excessProductionTaxMode: 'no_tax_in_demo',
      manualTaxAmountTl: 0,
      excessPurchasePaymentOffsetDays: 10,
    },
    expectedMonthly: {
      generationMWh: 10,
      selfConsumptionMWh: 10,
      gridConsumptionMWh: 0,
      excessMWh: 0,
    },
  },
  {
    id: 'excess_120',
    name: 'GES · %120 üretim',
    settings: {
      mode: 'advanced_metering',
      selfConsumptionRate: 100,
      totalProductionMwh: 144,
      simultaneousSelfConsumptionMwh: 120,
      gridImportMwh: 0,
      gridExportMwh: 24,
      excessAfterNettingMwh: 24,
      excessPurchasePrice: CONTRACT.ptfTlMwh,
      priceType: 'ptf',
      nettingMethod: 'monthly',
      settlementMode: 'cash_outflow',
      excessProductionTaxMode: 'no_tax_in_demo',
      manualTaxAmountTl: 0,
      excessPurchasePaymentOffsetDays: 10,
    },
    expectedMonthly: {
      generationMWh: 12,
      selfConsumptionMWh: 10,
      gridConsumptionMWh: 0,
      excessMWh: 2,
    },
  },
];

const customRow = (index: number, patch: Partial<PaymentPlanRow>): PaymentPlanRow => ({
  ...defaultPaymentRow(),
  ...patch,
  id: `k2-custom-row-${index}`,
  order: index,
});

export const createMatrixPaymentPlan = (templateId: string): PaymentPlan => {
  const plan = createPaymentPlan(templateId);
  if (templateId !== 'custom') return plan;
  return {
    ...plan,
    id: 'k2-payment-plan-custom',
    name: 'Özel Plan',
    rows: [
      customRow(1, {
        name: '%25 · 45 gün önce',
        amountType: 'period_invoice_percent',
        amountValue: 25,
        dateReference: 'period_start',
        dayOffset: -45,
      }),
      customRow(2, {
        name: '%25 · 15 gün önce',
        amountType: 'period_invoice_percent',
        amountValue: 25,
        dateReference: 'period_start',
        dayOffset: -15,
      }),
      customRow(3, {
        name: '%50 · 20 gün sonra',
        amountType: 'period_remaining_balance',
        amountValue: 0,
        dateReference: 'invoice_date',
        dayOffset: 20,
      }),
    ],
  };
};

export type ScenarioStatus = 'PASS' | 'FAIL' | 'REVIEW';

export interface ScenarioRecord {
  scenarioId: string;
  customerTypeId: string;
  customerTypeName: string;
  tariffType: string;
  voltageLevel: 'AG' | 'OG';
  termType: 'Tek Terimli' | 'Çift Terimli';
  paymentPlanId: string;
  paymentPlanName: string;
  paymentBehavior: PaymentBehavior;
  gesMode: GesCaseId;
  contractStart: string;
  contractEnd: string;
  contractMonths: number;
  monthlyConsumptionMWh: number;
  totalConsumptionMWh: number;
  ptf: number;
  yekdem: number;
  creditRate: number;
  valorRate: number;
  commissionPayer: string;
  vatRate: number;
  btvRate: number;
  distributionUnitPrice: number;
  contractPowerValue: number;
  tariffVersion: string;
  tariffValidityStart: string;
  tariffValidityEnd: string;
  grossConsumptionMWh: number;
  gesGenerationMWh: number;
  selfConsumptionMWh: number;
  gridConsumptionMWh: number;
  excessGenerationMWh: number;
  activeEnergyAmount: number;
  distributionAmount: number;
  contractPowerAmount: number;
  btvBase: number;
  btvAmount: number;
  vatBase: number;
  vatAmount: number;
  gesSettlementAmount: number;
  grossInvoiceAmount: number;
  scheduledCustomerPayment: number;
  actualCustomerPayment: number;
  cardPrincipal: number;
  cardCommission: number;
  bankGrossTransfer: number;
  bankNetTransfer: number;
  overpaymentAmount: number;
  refundedAmount: number;
  carriedForwardAmount: number;
  openReceivable: number;
  creditCost: number;
  valorIncome: number;
  netFinancingCost: number;
  minimumCashBalance: number;
  maximumCashBalance: number;
  endingCashBalance: number;
  maximumOpenFinancing: number;
  financingCloseDate: string;
  revenue: number;
  totalOperationalCost: number;
  totalFinancingCost: number;
  netProfit: number;
  profitMargin: number;
  profitPerMWh: number;
  invoiceReconciliationDifference: number;
  paymentAllocationDifference: number;
  cashflowReconciliationDifference: number;
  profitReconciliationDifference: number;
  hasNaN: boolean;
  hasInfinity: boolean;
  duplicatedCashEventCount: number;
  blocked: boolean;
  blockedReasons: string[];
  runtimeMs: number;
  status: ScenarioStatus;
  failedRules: string[];
  reviewRules: string[];
}

export interface RuleResult {
  rule: string;
  question: string;
  status: ScenarioStatus;
  expected: string;
  actual: string;
  difference: string;
  evidenceScenarios: string[];
  productionCode: string;
}
