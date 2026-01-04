import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { calculatePerformanceHistory, getHistoricalValuations } from "@/commands/portfolio";
import { useMemo, useRef } from "react";
import { format } from "date-fns";
import { DateRange } from "react-day-picker";
import { QueryKeys } from "@/lib/query-keys";
import { AccountValuation, PerformanceMetrics, TrackedItem } from "@/lib/types";

/**
 * Calculate XIRR (Extended Internal Rate of Return) using Newton-Raphson method
 * Cash flows: negative for deposits (money out), positive for withdrawals and final value
 */
function calculateXirr(
  cashFlows: { date: Date; amount: number }[],
  maxIterations: number = 100,
  tolerance: number = 1e-7,
): number | null {
  if (cashFlows.length < 2) return null;

  // Check if all amounts are zero
  const hasNonZero = cashFlows.some((cf) => cf.amount !== 0);
  if (!hasNonZero) return 0;

  // Get the first date as reference
  const startDate = cashFlows[0].date.getTime();

  // Convert dates to year fractions
  const flows = cashFlows.map((cf) => ({
    years: (cf.date.getTime() - startDate) / (365.25 * 24 * 60 * 60 * 1000),
    amount: cf.amount,
  }));

  // NPV function: sum of amount / (1 + rate)^years
  const npv = (rate: number): number => {
    return flows.reduce((sum, flow) => {
      const discountFactor = Math.pow(1 + rate, flow.years);
      return sum + flow.amount / discountFactor;
    }, 0);
  };

  // Derivative of NPV with respect to rate
  const npvDerivative = (rate: number): number => {
    return flows.reduce((sum, flow) => {
      if (flow.years === 0) return sum;
      const discountFactor = Math.pow(1 + rate, flow.years + 1);
      return sum - (flow.years * flow.amount) / discountFactor;
    }, 0);
  };

  // Newton-Raphson iteration
  let rate = 0.1; // Initial guess of 10%

  for (let i = 0; i < maxIterations; i++) {
    const npvValue = npv(rate);
    const derivative = npvDerivative(rate);

    if (Math.abs(derivative) < 1e-10) {
      // Try a different starting point
      rate = rate > 0 ? -0.1 : 0.5;
      continue;
    }

    const newRate = rate - npvValue / derivative;

    // Check for convergence
    if (Math.abs(newRate - rate) < tolerance) {
      // Validate result is reasonable (-100% to 1000%)
      if (newRate > -1 && newRate < 10) {
        return newRate;
      }
      return null;
    }

    // Bound the rate to prevent divergence
    rate = Math.max(-0.99, Math.min(10, newRate));
  }

  return null; // Failed to converge
}

/**
 * Calculate TWR, MWR (XIRR), and other performance metrics from valuation history
 * Optionally converts to base currency first
 */
function calculatePerformanceFromHistory(
  history: AccountValuation[],
  convertToBase: boolean = false,
): Partial<PerformanceMetrics> {
  if (!history?.length) {
    return {
      returns: [],
      cumulativeTwr: 0,
      annualizedTwr: 0,
      cumulativeMwr: 0,
      annualizedMwr: 0,
      volatility: 0,
      maxDrawdown: 0,
    };
  }

  // Convert to base currency if needed
  const valuations = convertToBase
    ? history.map((v) => ({
        ...v,
        totalValue: v.totalValue * (v.fxRateToBase || 1),
        netContribution: v.netContribution * (v.fxRateToBase || 1),
      }))
    : history;

  // Calculate daily returns and cumulative TWR
  const returns: { date: string; value: number }[] = [];
  let twr = 1;
  const dailyReturns: number[] = [];

  // Build cash flows for XIRR calculation (always in base currency/USD)
  // For a date range: treat starting value as initial investment, ending value as final return
  // Cash flows: negative = money invested, positive = money returned
  const cashFlows: { date: Date; amount: number }[] = [];

  // First cash flow: starting portfolio value in base currency as initial investment (negative)
  const firstValuation = history[0];
  const firstValueBase = firstValuation.totalValue * (firstValuation.fxRateToBase || 1);
  cashFlows.push({
    date: new Date(firstValuation.valuationDate),
    amount: -firstValueBase, // Starting value as outflow (as if investing this amount)
  });

  for (let i = 1; i < valuations.length; i++) {
    const prev = valuations[i - 1];
    const curr = valuations[i];
    const cf = curr.netContribution - prev.netContribution;

    // TWR calculation - original formula (cash flow adjusted end value / start value)
    if (prev.totalValue > 0) {
      const dailyReturn = (curr.totalValue - cf) / prev.totalValue;
      twr *= dailyReturn;
      dailyReturns.push(dailyReturn - 1);
    }

    // For XIRR: Convert cash flow to base currency using the FX rate at the time of the transaction
    // This is the key fix: each cash flow is converted using its own FX rate, not cumulative conversion
    const currHistory = history[i];
    const cfLocal = currHistory.netContribution - history[i - 1].netContribution;
    if (cfLocal !== 0) {
      // Convert the local currency cash flow to base currency using the rate at transaction time
      const cfBase = cfLocal * (currHistory.fxRateToBase || 1);
      cashFlows.push({
        date: new Date(currHistory.valuationDate),
        amount: -cfBase, // Deposit is negative (outflow), withdrawal is positive (inflow)
      });
    }

    returns.push({ date: curr.valuationDate, value: twr - 1 });
  }

  // Add initial return point
  returns.unshift({ date: valuations[0].valuationDate, value: 0 });

  // Final cash flow: ending portfolio value in base currency (positive - money returned)
  const lastValuation = history[history.length - 1];
  const lastValueBase = lastValuation.totalValue * (lastValuation.fxRateToBase || 1);
  cashFlows.push({
    date: new Date(lastValuation.valuationDate),
    amount: lastValueBase, // Final value as inflow (in base currency)
  });

  const cumulativeTwr = twr - 1;

  // Calculate annualized TWR (same as original)
  const firstDate = new Date(valuations[0].valuationDate);
  const lastDate = new Date(valuations[valuations.length - 1].valuationDate);
  const days = Math.max(1, (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24));
  const years = days / 365;
  const annualizedTwr = years > 0 ? Math.pow(1 + cumulativeTwr, 1 / years) - 1 : 0;

  // Calculate XIRR (true money-weighted return with proper cash flow timing)
  const xirr = calculateXirr(cashFlows);
  const annualizedMwr = xirr !== null && isFinite(xirr) ? xirr : 0;
  const cumulativeMwr = years > 0 ? Math.pow(1 + annualizedMwr, years) - 1 : annualizedMwr;

  // Calculate volatility
  let volatility = 0;
  if (dailyReturns.length > 1) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (dailyReturns.length - 1);
    volatility = Math.sqrt(variance * 252);
  }

  // Calculate max drawdown
  let maxDrawdown = 0;
  let peak = valuations[0].totalValue;
  for (const v of valuations) {
    if (v.totalValue > peak) peak = v.totalValue;
    const drawdown = peak > 0 ? (peak - v.totalValue) / peak : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return {
    returns,
    cumulativeTwr,
    annualizedTwr,
    cumulativeMwr,
    annualizedMwr,
    volatility,
    maxDrawdown,
  };
}

/**
 * Hook to calculate cumulative returns for a list of comparison items.
 * Automatically determines the effective start date based on the first available data point
 * from the first selected account.
 *
 * @param selectedItems List of comparison items to calculate cumulative returns for.
 * @param dateRange The date range for the calculation period.
 *
 * @returns An object containing the calculated cumulative returns data,
 *          a boolean indicating whether the data is loading,
 *          a boolean indicating whether there are any errors,
 *          an array of error messages,
 *          the effective start date used for calculations,
 *          and a formatted display date range string.
 */
export function useCalculatePerformanceHistory({
  selectedItems,
  dateRange,
}: {
  selectedItems: TrackedItem[];
  dateRange: DateRange | undefined;
}) {
  // Use a ref to track the effective start date without causing re-renders
  const effectiveStartDateRef = useRef<string | null>(null);

  // Use a ref to track if we've already processed the data for the current selection
  const processedRef = useRef<{
    selectedItemIds: string[];
    dateFrom: string | null;
    effectiveStartDate: string | null;
  }>({
    selectedItemIds: [],
    dateFrom: null,
    effectiveStartDate: null,
  });

  // Get the formatted date range for API calls, keep as undefined if not present
  const startDate = dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined;
  const endDate = dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined;

  // Check if we need to update our tracking refs
  const currentSelectionKey = selectedItems.map((item) => item.id).join(",");
  const hasSelectionChanged =
    currentSelectionKey !== processedRef.current.selectedItemIds.join(",");
  const hasDateChanged = startDate !== processedRef.current.dateFrom;

  // If selection or date changed, reset the processed state
  if (hasSelectionChanged || hasDateChanged) {
    processedRef.current = {
      selectedItemIds: selectedItems.map((item) => item.id),
      dateFrom: startDate || null, // Store startDate or null in ref
      effectiveStartDate: null,
    };
    effectiveStartDateRef.current = null;
  }

  // Use the effective start date if available, otherwise use the original start date (potentially undefined)
  const startDateToUse = effectiveStartDateRef.current || startDate;

  // Separate accounts and symbols
  const accountItems = selectedItems.filter((item) => item.type === "account");
  const symbolItems = selectedItems.filter((item) => item.type === "symbol");

  // Fetch valuation history for accounts (to calculate base currency returns)
  const valuationQueries = useQueries({
    queries: accountItems.map((item) => ({
      queryKey: [QueryKeys.HISTORY_VALUATION, "base", item.id, startDateToUse, endDate],
      queryFn: () => getHistoricalValuations(item.id, startDateToUse!, endDate!),
      enabled: !!item.id && !!startDateToUse && !!endDate,
      staleTime: 30 * 1000,
      retry: false,
      placeholderData: keepPreviousData,
    })),
  });

  // Fetch performance data for symbols (benchmarks) - use backend calculation
  const symbolQueries = useQueries({
    queries: symbolItems.map((item) => ({
      queryKey: [QueryKeys.PERFORMANCE_HISTORY, item.type, item.id, startDateToUse, endDate],
      queryFn: () => calculatePerformanceHistory(item.type, item.id, startDateToUse!, endDate!),
      enabled: !!item.id && !!startDateToUse && !!endDate,
      staleTime: 30 * 1000,
      retry: false,
      placeholderData: keepPreviousData,
    })),
  });

  const isLoading =
    valuationQueries.some((query) => query.isLoading) ||
    symbolQueries.some((query) => query.isLoading);
  const hasErrors =
    valuationQueries.some((query) => query.isError) ||
    symbolQueries.some((query) => query.isError);
  const errorMessages = [
    ...valuationQueries
      .filter((query) => query.isError)
      .map((query) => query.error)
      .filter(Boolean)
      .map((error) => (error instanceof Error ? error.message : String(error))),
    ...symbolQueries
      .filter((query) => query.isError)
      .map((query) => query.error)
      .filter(Boolean)
      .map((error) => (error instanceof Error ? error.message : String(error))),
  ];

  // Calculate base currency performance for accounts from valuation history
  const accountChartData = useMemo(() => {
    return valuationQueries
      .map((query, index) => {
        if (query.isError || !query.data?.length) return null;

        const item = accountItems[index];
        const history = query.data;

        // Check if account needs base currency conversion
        const needsConversion =
          history.length > 0 && history[0].accountCurrency !== history[0].baseCurrency;

        const performance = calculatePerformanceFromHistory(history, needsConversion);

        return {
          id: item.id,
          type: item.type,
          name: item.name,
          currency: history[0]?.baseCurrency || "USD",
          ...performance,
        };
      })
      .filter(Boolean);
  }, [valuationQueries, accountItems]);

  // Format symbol chart data from query results
  const symbolChartData = useMemo(() => {
    return symbolQueries
      .map((query, index) => {
        if (query.isError || !query.data) return null;

        const item = symbolItems[index];
        return {
          ...query.data,
          id: item.id,
          type: item.type,
          name: `${item.name} (${item.id})`,
        };
      })
      .filter(Boolean);
  }, [symbolQueries, symbolItems]);

  // Merge account and symbol data, maintaining original order
  const chartData = useMemo(() => {
    return selectedItems
      .map((item) => {
        if (item.type === "account") {
          return accountChartData.find((d) => d?.id === item.id) || null;
        } else {
          return symbolChartData.find((d) => d?.id === item.id) || null;
        }
      })
      .filter(Boolean);
  }, [selectedItems, accountChartData, symbolChartData]);

  // Process performance data to determine effective start date (only once per data set)
  if (
    chartData?.length &&
    startDate && // Only adjust effective date if an initial start date was provided
    !effectiveStartDateRef.current &&
    !processedRef.current.effectiveStartDate
  ) {
    // Find the first account in the selected items
    const firstAccountItem = selectedItems.find((item) => item.type === "account");

    if (firstAccountItem) {
      // Find the performance data for the first account
      const firstAccountData = chartData.find((data) => data?.id === firstAccountItem.id);

      if (firstAccountData?.returns?.length) {
        // Get the first date string from the returns data
        const firstDataDateStr = firstAccountData.returns[0].date;

        // Compare date strings directly (YYYY-MM-DD format strings can be compared lexicographically)
        const effectiveStartDate = firstDataDateStr > startDate ? firstDataDateStr : startDate;

        effectiveStartDateRef.current = effectiveStartDate;
        processedRef.current.effectiveStartDate = effectiveStartDate;
      }
    }
  }

  // Format the effective date for display
  const displayStartDate = effectiveStartDateRef.current
    ? format(new Date(effectiveStartDateRef.current + "T00:00:00"), "MMM d, yyyy") // Add time part for correct Date parsing
    : dateRange?.from
      ? format(dateRange.from, "MMM d, yyyy")
      : "";

  const displayEndDate = dateRange?.to ? format(dateRange.to, "MMM d, yyyy") : "";

  const displayDateRange =
    displayStartDate && displayEndDate
      ? `${displayStartDate} - ${displayEndDate}`
      : "Compare account performance over time";

  return {
    data: chartData,
    isLoading,
    hasErrors,
    errorMessages,
    effectiveStartDate: effectiveStartDateRef.current,
    formattedStartDate: startDate,
    formattedEndDate: endDate,
    displayDateRange,
    isCustomRange:
      effectiveStartDateRef.current !== null && effectiveStartDateRef.current !== startDate,
  };
}
