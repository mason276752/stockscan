// The concept fallback lists: what each figure can be called in US-GAAP or
// IFRS, in the order they are tried (indicators.js `first`), plus which
// concepts that makes interchangeable (quarters.js, for a filer that renames
// a line mid-year). Its own module so both can have it without a cycle.

// Concept fallbacks (US-GAAP first, then IFRS). Lists are tried in order.
// Some entries are the pre-2014 spellings of a figure (SalesRevenueGoodsNet
// for what is now Revenues): they are only reached when none of the current
// ones is in the filing, and they are what the filings the quarterly
// datasets reach back into are tagged with (server/lib/dera.js).
export const C = {
  revenue: ['us-gaap:Revenues', 'us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax', 'us-gaap:SalesRevenueNet', 'us-gaap:SalesRevenueGoodsNet', 'us-gaap:SalesRevenueServicesNet', 'us-gaap:RevenuesNetOfInterestExpense', 'us-gaap:RegulatedAndUnregulatedOperatingRevenue', 'us-gaap:RevenuesExcludingInterestAndDividends', 'us-gaap:RealEstateRevenueNet', 'ifrs-full:Revenue', 'ifrs-full:RevenueFromContractsWithCustomers', 'ifrs-full:RevenueFromSaleOfGoods', 'ifrs-full:RevenueFromRenderingOfServices', 'ifrs-full:RevenueAndOperatingIncome', 'ifrs-full:InsuranceRevenue', 'ifrs-full:RevenueFromRenderingOfTelecommunicationServices', 'ifrs-full:RevenueFromRenderingOfTransportServices', 'ifrs-full:RevenueFromRenderingOfCargoAndMailTransportServices', 'us-gaap:RegulatedOperatingRevenue', 'us-gaap:RegulatedOperatingRevenueGas', 'us-gaap:RegulatedOperatingRevenueElectric', 'us-gaap:OilAndGasRevenue', 'us-gaap:OperatingLeaseLeaseIncome', 'us-gaap:FeeIncome'],
  // banks: net revenue = net interest income + non-interest income
  netInterestIncome: ['us-gaap:InterestIncomeExpenseNet', 'us-gaap:InterestIncomeExpenseAfterProvisionForLoanLoss', 'ifrs-full:InterestRevenueExpense'],
  interestIncome: ['us-gaap:InterestAndDividendIncomeOperating', 'us-gaap:InterestIncomeOperating', 'ifrs-full:RevenueFromInterest'],
  noninterestIncome: ['us-gaap:NoninterestIncome', 'ifrs-full:FeeAndCommissionIncome'],
  // BDCs / investment companies: total investment income is the revenue, net investment income the operating result
  bdcRevenue: ['us-gaap:GrossInvestmentIncomeOperating'],
  bdcNetInvestmentIncome: ['us-gaap:NetInvestmentIncome'],
  costsAndExpenses: ['us-gaap:CostsAndExpenses', 'us-gaap:OperatingCostsAndExpenses', 'us-gaap:BenefitsLossesAndExpenses'],
  // total operating expenses below gross profit (or all costs when there is no cost of revenue)
  opexTotal: ['us-gaap:OperatingExpenses', 'ifrs-full:OperatingExpense'],
  nonoperating: ['us-gaap:NonoperatingIncomeExpense'],
  // statement lines offered as screener filters (amounts, not ratios)
  longTermDebt: ['us-gaap:LongTermDebtNoncurrent', 'us-gaap:LongTermDebt', 'us-gaap:LongTermDebtAndCapitalLeaseObligations', 'us-gaap:DebtInstrumentCarryingAmount', 'ifrs-full:NoncurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings', 'ifrs-full:LongtermBorrowings', 'ifrs-full:NoncurrentBorrowings'],
  rd: ['us-gaap:ResearchAndDevelopmentExpense', 'us-gaap:ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost', 'ifrs-full:ResearchAndDevelopmentExpense'],
  sga: ['us-gaap:SellingGeneralAndAdministrativeExpense', 'us-gaap:GeneralAndAdministrativeExpense', 'ifrs-full:SellingGeneralAndAdministrativeExpense', 'ifrs-full:AdministrativeExpense'],
  incomeTax: ['us-gaap:IncomeTaxExpenseBenefit', 'ifrs-full:IncomeTaxExpenseContinuingOperations'],
  buybacks: ['us-gaap:PaymentsForRepurchaseOfCommonStock', 'us-gaap:PaymentsForRepurchaseOfEquity', 'ifrs-full:PaymentsToAcquireOrRedeemEntitysShares'],
  stockIssued: ['us-gaap:ProceedsFromIssuanceOfCommonStock', 'us-gaap:ProceedsFromIssuanceOrSaleOfEquity', 'us-gaap:ProceedsFromIssuanceInitialPublicOffering', 'ifrs-full:ProceedsFromIssuingShares'],
  sharesDiluted: ['us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding', 'us-gaap:WeightedAverageNumberOfShareOutstandingBasicAndDiluted', 'us-gaap:WeightedAverageNumberOfSharesOutstandingBasic', 'ifrs-full:AdjustedWeightedAverageShares', 'ifrs-full:WeightedAverageShares'],
  // the usual lines between operating and pre-tax income, for filers without an operating income line
  interestExpenseNonop: ['us-gaap:InterestExpenseNonoperating', 'us-gaap:InterestExpense', 'us-gaap:InterestExpenseDebt', 'us-gaap:InterestAndDebtExpense', 'us-gaap:InterestIncomeExpenseNonoperatingNet', 'us-gaap:InvestmentAndDebtInterestIncomeExpenseNet', 'ifrs-full:FinanceCosts'],
  interestIncomeNonop: ['us-gaap:InvestmentIncomeInterest', 'us-gaap:InvestmentIncomeInterestAndDividend', 'us-gaap:InterestIncomeOther', 'us-gaap:InvestmentIncomeNonoperating', 'ifrs-full:FinanceIncome'],
  otherNonop: ['us-gaap:OtherNonoperatingIncomeExpense', 'us-gaap:OtherNonoperatingIncome', 'us-gaap:OtherIncome'],
  cogs: ['us-gaap:CostOfRevenue', 'us-gaap:CostOfGoodsSold', 'ifrs-full:CostOfSales', 'us-gaap:CostOfGoodsAndServicesSold', 'us-gaap:CostOfServices', 'us-gaap:CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization', 'us-gaap:CostOfGoodsSoldExcludingDepreciationDepletionAndAmortization'],
  // some filers show cost of revenue as a base line plus separate amortisation / depreciation lines (Intuit, Broadcom …)
  cogsTotal: ['us-gaap:CostOfRevenue', 'us-gaap:CostOfGoodsSold', 'ifrs-full:CostOfSales'],
  // the estimate first: when present it already includes the partial line plus the direct-cost lines beside it
  cogsPartial: ['synthetic:CostOfRevenueFromHeading', 'us-gaap:CostOfGoodsAndServicesSold', 'us-gaap:CostOfServices', 'us-gaap:CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization', 'us-gaap:CostOfGoodsSoldExcludingDepreciationDepletionAndAmortization', 'us-gaap:CostOfServicesExcludingDepreciationDepletionAndAmortization', 'us-gaap:CostDirectMaterial'],
  cogsPartialReal: ['us-gaap:CostOfGoodsAndServicesSold', 'us-gaap:CostOfServices', 'us-gaap:CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization', 'us-gaap:CostOfGoodsSoldExcludingDepreciationDepletionAndAmortization', 'us-gaap:CostOfServicesExcludingDepreciationDepletionAndAmortization', 'us-gaap:CostDirectMaterial'],
  cogsSynthetic: ['synthetic:CostOfRevenueFromHeading'],
  noCogs: ['synthetic:NoCostOfRevenue'], // the statement has expenses but none is a cost of revenue
  cogsAmort: ['us-gaap:CostOfGoodsAndServicesSoldAmortization', 'us-gaap:CostOfGoodsSoldAmortization'],
  cogsDA: ['us-gaap:CostOfGoodsAndServicesSoldDepreciationAndAmortization', 'us-gaap:CostOfGoodsAndServicesSoldDepreciation'],
  grossProfit: ['us-gaap:GrossProfit', 'ifrs-full:GrossProfit'],
  operatingIncome: ['us-gaap:OperatingIncomeLoss', 'ifrs-full:ProfitLossFromOperatingActivities'],
  pretaxIncome: [
    'us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
    'us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
    'us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic',
    'ifrs-full:ProfitLossBeforeTax',
  ],
  netIncome: ['us-gaap:NetIncomeLoss', 'us-gaap:NetIncomeLossAvailableToCommonStockholdersBasic', 'us-gaap:ProfitLoss', 'ifrs-full:ProfitLossAttributableToOwnersOfParent', 'ifrs-full:ProfitLoss', 'ifrs-full:ProfitLossFromContinuingOperations', 'us-gaap:NetIncreaseDecreaseInNetAssetsResultingFromOperations'],
  eps: ['us-gaap:EarningsPerShareDiluted', 'us-gaap:EarningsPerShareBasicAndDiluted', 'us-gaap:EarningsPerShareBasic', 'us-gaap:IncomeLossFromContinuingOperationsPerDilutedShare', 'us-gaap:IncomeLossFromContinuingOperationsPerBasicShare', 'ifrs-full:DilutedEarningsLossPerShare', 'ifrs-full:BasicEarningsLossPerShare', 'ifrs-full:DilutedEarningsLossPerShareFromContinuingOperations', 'ifrs-full:BasicEarningsLossPerShareFromContinuingOperations'],
  ocf: ['us-gaap:NetCashProvidedByUsedInOperatingActivities', 'us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations', 'ifrs-full:CashFlowsFromUsedInOperatingActivities', 'ifrs-full:CashFlowsFromUsedInOperatingActivitiesContinuingOperations'],
  icf: ['us-gaap:NetCashProvidedByUsedInInvestingActivities', 'us-gaap:NetCashProvidedByUsedInInvestingActivitiesContinuingOperations', 'ifrs-full:CashFlowsFromUsedInInvestingActivities'],
  fcf: ['us-gaap:NetCashProvidedByUsedInFinancingActivities', 'us-gaap:NetCashProvidedByUsedInFinancingActivitiesContinuingOperations', 'ifrs-full:CashFlowsFromUsedInFinancingActivities'],
  capex: ['us-gaap:PaymentsToAcquirePropertyPlantAndEquipment', 'us-gaap:PaymentsToAcquireProductiveAssets', 'us-gaap:PaymentsToAcquireOtherPropertyPlantAndEquipment', 'us-gaap:PaymentsForCapitalImprovements', 'us-gaap:PaymentsToAcquireOilAndGasPropertyAndEquipment', 'us-gaap:PaymentsToAcquireOilAndGasProperty', 'us-gaap:PaymentsToAcquireMachineryAndEquipment', 'us-gaap:PaymentsForFlightEquipment', 'us-gaap:PaymentsToAcquireOilAndGasEquipment', 'us-gaap:PaymentsToAcquireRealEstate', 'us-gaap:PaymentsToDevelopRealEstateAssets', 'us-gaap:PaymentsToAcquireCommercialRealEstate', 'us-gaap:PaymentsForConstructionInProcess', 'us-gaap:PaymentsToAcquireOtherProductiveAssets', 'ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities', 'ifrs-full:PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets'],
  // bought intangibles (software, licences) are capital spending too
  capexIntangibles: ['us-gaap:PaymentsToAcquireIntangibleAssets', 'us-gaap:PaymentsToDevelopSoftware', 'ifrs-full:PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities'],
  dividends: ['us-gaap:PaymentsOfDividends', 'us-gaap:PaymentsOfDividendsCommonStock', 'us-gaap:PaymentsOfOrdinaryDividends', 'us-gaap:PaymentsOfDividendsCommonStock', 'ifrs-full:DividendsPaidClassifiedAsFinancingActivities', 'ifrs-full:DividendsPaid'],
  // balances
  cash: ['us-gaap:CashAndCashEquivalentsAtCarryingValue', 'us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsIncludingDisposalGroupAndDiscontinuedOperations', 'us-gaap:CashAndCashEquivalentsAtCarryingValueIncludingDiscontinuedOperations', 'us-gaap:CashAndDueFromBanks', 'us-gaap:CashCashEquivalentsAndFederalFundsSold', 'us-gaap:CashCashEquivalentsAndShortTermInvestments', 'us-gaap:Cash', 'us-gaap:CashEquivalentsAtCarryingValue', 'ifrs-full:CashAndCashEquivalents', 'ifrs-full:Cash', 'ifrs-full:CashAndBankBalancesAtCentralBanks', 'us-gaap:CashAndCashEquivalentsFairValueDisclosure'],
  ar: ['us-gaap:AccountsReceivableNetCurrent', 'us-gaap:ReceivablesNetCurrent', 'us-gaap:AccountsNotesAndLoansReceivableNetCurrent', 'us-gaap:AccountsAndOtherReceivablesNetCurrent', 'us-gaap:AccountsReceivableNet', 'us-gaap:ContractWithCustomerReceivableAfterAllowanceForCreditLossCurrent', 'us-gaap:ContractWithCustomerReceivableAfterAllowanceForCreditLoss', 'us-gaap:PremiumsReceivableAtCarryingValue', 'us-gaap:AccountsReceivableGrossCurrent', 'us-gaap:AccountsAndNotesReceivableNet', 'ifrs-full:CurrentTradeReceivables', 'ifrs-full:TradeAndOtherCurrentReceivables', 'ifrs-full:TradeReceivables'],
  inventory: ['us-gaap:InventoryNet', 'us-gaap:InventoryGross', 'us-gaap:InventoryNetOfAllowancesCustomerAdvancesAndProgressBillings', 'us-gaap:EnergyRelatedInventory', 'us-gaap:RetailRelatedInventoryMerchandise', 'us-gaap:AirlineRelatedInventoryNet', 'us-gaap:InventoryRealEstate', 'us-gaap:InventoryOperativeBuilders', 'us-gaap:FIFOInventoryAmount', 'us-gaap:InventoryFinishedGoodsNetOfReserves', 'us-gaap:InventoryRawMaterialsAndSupplies', 'us-gaap:EnergyRelatedInventoryNaturalGasInStorage', 'ifrs-full:Inventories'],
  prepaid: ['us-gaap:PrepaidExpenseCurrent'],
  currentAssets: ['us-gaap:AssetsCurrent', 'ifrs-full:CurrentAssets', 'ifrs-full:CurrentAssetsOtherThanAssetsOrDisposalGroupsClassifiedAsHeldForSaleOrAsHeldForDistributionToOwners'],
  nonCurrentAssets: ['us-gaap:AssetsNoncurrent', 'ifrs-full:NoncurrentAssets'],
  totalAssets: ['us-gaap:Assets', 'ifrs-full:Assets'],
  ppe: ['us-gaap:PropertyPlantAndEquipmentNet', 'us-gaap:PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization', 'us-gaap:PropertyPlantAndEquipmentExcludingLessorAssetUnderOperatingLeaseAfterAccumulatedDepreciation', 'us-gaap:PublicUtilitiesPropertyPlantAndEquipmentNet', 'us-gaap:RealEstateInvestmentPropertyNet', 'us-gaap:RealEstateInvestments', 'us-gaap:PropertySubjectToOrAvailableForOperatingLeaseNet', 'us-gaap:OilAndGasPropertySuccessfulEffortMethodNet', 'us-gaap:OilAndGasPropertyFullCostMethodNet', 'us-gaap:PropertyPlantAndEquipmentOtherNet', 'ifrs-full:PropertyPlantAndEquipment', 'ifrs-full:PropertyPlantAndEquipmentIncludingRightofuseAssets', 'ifrs-full:InvestmentProperty'],
  ppeGross: ['us-gaap:PropertyPlantAndEquipmentGross', 'us-gaap:PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetBeforeAccumulatedDepreciationAndAmortization', 'us-gaap:RealEstateInvestmentPropertyAtCost', 'us-gaap:PublicUtilitiesPropertyPlantAndEquipmentPlantInService', 'ifrs-full:PropertyPlantAndEquipmentGrossCarryingAmount'],
  ltInvestments: ['us-gaap:LongTermInvestments', 'us-gaap:OtherLongTermInvestments', 'us-gaap:MarketableSecuritiesNoncurrent', 'us-gaap:EquityMethodInvestments', 'ifrs-full:NoncurrentFinancialAssets', 'ifrs-full:InvestmentAccountedForUsingEquityMethod'],
  otherAssets: ['us-gaap:OtherAssetsNoncurrent', 'ifrs-full:OtherNoncurrentAssets'],
  ap: ['us-gaap:AccountsPayableCurrent', 'us-gaap:AccountsPayableTradeCurrent', 'us-gaap:AccountsPayableAndAccruedLiabilitiesCurrent', 'us-gaap:AccountsPayableAndOtherAccruedLiabilitiesCurrent', 'us-gaap:AccountsPayableCurrentAndNoncurrent', 'us-gaap:AccountsPayableAndAccruedLiabilitiesCurrentAndNoncurrent', 'us-gaap:AccountsPayableAndOtherAccruedLiabilities', 'us-gaap:OtherAccountsPayableAndAccruedLiabilities', 'ifrs-full:TradeAndOtherCurrentPayablesToTradeSuppliers', 'ifrs-full:TradeAndOtherPayablesToTradeSuppliers', 'ifrs-full:TradeAndOtherCurrentPayables', 'ifrs-full:TradeAndOtherPayables'],
  currentLiabilities: ['us-gaap:LiabilitiesCurrent', 'ifrs-full:CurrentLiabilities', 'ifrs-full:CurrentLiabilitiesOtherThanLiabilitiesIncludedInDisposalGroupsClassifiedAsHeldForSale'],
  totalLiabilities: ['us-gaap:Liabilities', 'ifrs-full:Liabilities'],
  nonCurrentLiabilities: ['us-gaap:LiabilitiesNoncurrent', 'ifrs-full:NoncurrentLiabilities'],
  equityParent: ['us-gaap:StockholdersEquity', 'us-gaap:PartnersCapital', 'us-gaap:MembersEquity', 'ifrs-full:EquityAttributableToOwnersOfParent'],
  equityTotal: ['us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'us-gaap:StockholdersEquity', 'us-gaap:PartnersCapitalIncludingPortionAttributableToNoncontrollingInterest', 'us-gaap:PartnersCapital', 'us-gaap:LimitedLiabilityCompanyLlcMembersEquityIncludingPortionAttributableToNoncontrollingInterest', 'us-gaap:MembersEquity', 'ifrs-full:Equity', 'ifrs-full:EquityAttributableToOwnersOfParent'],
  liabilitiesAndEquity: ['us-gaap:LiabilitiesAndStockholdersEquity', 'ifrs-full:EquityAndLiabilities'],
  paidInCapital: ['us-gaap:CommonStocksIncludingAdditionalPaidInCapital', 'ifrs-full:IssuedCapital'],
  commonStock: ['us-gaap:CommonStockValue', 'us-gaap:CommonStockValueOutstanding'],
  apic: ['us-gaap:AdditionalPaidInCapital', 'us-gaap:AdditionalPaidInCapitalCommonStock', 'ifrs-full:SharePremium'],
};

// Concepts in the same list mean the same figure, so a series reported under
// one name and then another is still one series: quarters.js needs that to
// subtract a year-to-date column from the one before it (Alphabet's dividends
// paid went from us-gaap:PaymentsOfDividends to us-gaap:PaymentsOfOrdinary-
// Dividends in its 2026 Q2 10-Q). `synthetic:` values are estimates this code
// derives, not reported facts, so they are left out - and so are the two
// lists that are a preference order rather than one figure: basic and diluted
// per-share numbers are genuinely different, and subtracting a year-to-date
// column of one from the other would mix the two bases.
const PREFERENCE_ONLY = new Set(['eps', 'sharesDiluted']);
export const SIBLINGS = (() => {
  const m = new Map();
  for (const [key, list] of Object.entries(C)) {
    if (PREFERENCE_ONLY.has(key)) continue;
    const real = [...new Set(list)].filter((c) => !c.startsWith('synthetic:'));
    if (real.length < 2) continue;
    for (const c of real) {
      const set = m.get(c) || new Set();
      for (const o of real) if (o !== c) set.add(o);
      m.set(c, set);
    }
  }
  return m;
})();
