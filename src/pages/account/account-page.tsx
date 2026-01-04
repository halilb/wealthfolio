import { getHoldings } from "@/commands/portfolio";
import { HistoryChart } from "@/components/history-chart";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  GainAmount,
  GainPercent,
  IntervalSelector,
  Page,
  PageContent,
  PageHeader,
  PrivacyAmount,
} from "@wealthfolio/ui";
import { useMemo, useState } from "react";

import { MobileActionsMenu } from "@/components/mobile-actions-menu";
import { PrivacyToggle } from "@/components/privacy-toggle";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useAccounts } from "@/hooks/use-accounts";
import { useUsdDisplay } from "@/hooks/use-usd-display";
import { useValuationHistory } from "@/hooks/use-valuation-history";
import { AccountType } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import {
  Account,
  AccountValuation,
  DateRange,
  Holding,
  TimePeriod,
  TrackedItem,
} from "@/lib/types";
import { calculatePerformanceMetrics, cn } from "@/lib/utils";
import { PortfolioUpdateTrigger } from "@/pages/dashboard/portfolio-update-trigger";
import { useCalculatePerformanceHistory } from "@/pages/performance/hooks/use-performance-data";
import { useQuery } from "@tanstack/react-query";
import { Icons, type Icon } from "@wealthfolio/ui";
import { subMonths } from "date-fns";
import { useNavigate, useParams } from "react-router-dom";
import { AccountContributionLimit } from "./account-contribution-limit";
import AccountHoldings from "./account-holdings";
import AccountMetrics from "./account-metrics";

interface HistoryChartData {
  date: string;
  totalValue: number;
  netContribution: number;
  currency: string;
}

// Map account types to icons for visual distinction
const accountTypeIcons: Record<AccountType, Icon> = {
  SECURITIES: Icons.Briefcase,
  CASH: Icons.DollarSign,
  CRYPTOCURRENCY: Icons.Bitcoin,
};

// Helper function to get the initial date range (copied from dashboard)
const getInitialDateRange = (): DateRange => ({
  from: subMonths(new Date(), 3),
  to: new Date(),
});

// Define the initial interval code (consistent with other pages)
const INITIAL_INTERVAL_CODE: TimePeriod = "3M";

const AccountPage = () => {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [dateRange, setDateRange] = useState<DateRange | undefined>(getInitialDateRange());
  const [selectedIntervalCode, setSelectedIntervalCode] =
    useState<TimePeriod>(INITIAL_INTERVAL_CODE);
  const [desktopSelectorOpen, setDesktopSelectorOpen] = useState(false);
  const [mobileSelectorOpen, setMobileSelectorOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);

  const { accounts, isLoading: isAccountsLoading } = useAccounts();
  const account = useMemo(() => accounts?.find((acc) => acc.id === id), [accounts, id]);
  const { isUsdDisplay, toggleUsdDisplay } = useUsdDisplay();

  // Query holdings to check if account has any assets
  const { data: holdings, isLoading: isHoldingsLoading } = useQuery<Holding[], Error>({
    queryKey: [QueryKeys.HOLDINGS, id],
    queryFn: () => getHoldings(id),
  });

  // Check if account has any holdings (including cash)
  const hasHoldings = useMemo(() => {
    if (!holdings) return false;
    return holdings.length > 0;
  }, [holdings]);

  // Group accounts by type for the selector
  const accountsByType = useMemo(() => {
    const grouped: Record<string, Account[]> = {};
    accounts.forEach((acc) => {
      if (!grouped[acc.accountType]) {
        grouped[acc.accountType] = [];
      }
      grouped[acc.accountType].push(acc);
    });
    return Object.entries(grouped);
  }, [accounts]);

  const accountTrackedItem: TrackedItem | undefined = useMemo(() => {
    if (account) {
      return { id: account.id, type: "account", name: account.name };
    }
    return undefined;
  }, [account]);

  const { data: performanceResponse, isLoading: isPerformanceHistoryLoading } =
    useCalculatePerformanceHistory({
      selectedItems: accountTrackedItem ? [accountTrackedItem] : [],
      dateRange: dateRange,
    });

  const accountPerformance = performanceResponse?.[0] || null;

  const { valuationHistory, isLoading: isValuationHistoryLoading } = useValuationHistory(
    dateRange,
    id,
  );

  // Determine if we should show USD (only if account is non-USD and user toggled it)
  const showInUsd = isUsdDisplay && account?.currency !== "USD";

  // Convert valuation history to USD when USD display is active
  const displayHistory = useMemo(() => {
    if (!showInUsd || !valuationHistory) return valuationHistory;
    return valuationHistory.map((v) => ({
      ...v,
      totalValue: v.totalValue * (v.fxRateToBase || 1),
      netContribution: v.netContribution * (v.fxRateToBase || 1),
      investmentMarketValue: v.investmentMarketValue * (v.fxRateToBase || 1),
      costBasis: v.costBasis * (v.fxRateToBase || 1),
      cashBalance: v.cashBalance * (v.fxRateToBase || 1),
      accountCurrency: v.baseCurrency,
    }));
  }, [valuationHistory, showInUsd]);

  // Current display currency
  const displayCurrency = showInUsd ? "USD" : (account?.currency ?? "USD");

  // Calculate gainLossAmount and simpleReturn from displayHistory (USD-converted when enabled)
  const { gainLossAmount: frontendGainLossAmount, simpleReturn: frontendSimpleReturn } =
    useMemo(() => {
      return calculatePerformanceMetrics(displayHistory, selectedIntervalCode === "ALL");
    }, [displayHistory, selectedIntervalCode, showInUsd]);

  const chartData: HistoryChartData[] = useMemo(() => {
    if (!displayHistory) return [];
    return displayHistory.map((valuation: AccountValuation) => ({
      date: valuation.valuationDate,
      totalValue: valuation.totalValue,
      netContribution: valuation.netContribution,
      currency: valuation.accountCurrency,
    }));
  }, [displayHistory]);

  const currentValuation = displayHistory?.[displayHistory.length - 1];

  const isLoading = isAccountsLoading || isValuationHistoryLoading;
  const isDetailsLoading = isLoading || isPerformanceHistoryLoading;

  // Callback for IntervalSelector
  const handleIntervalSelect = (
    code: TimePeriod,
    _description: string,
    range: DateRange | undefined,
  ) => {
    setSelectedIntervalCode(code);
    setDateRange(range);
  };

  // Calculate USD-adjusted performance metrics from displayHistory
  const displayPerformance = useMemo(() => {
    if (!showInUsd || !accountPerformance) return accountPerformance;
    if (!displayHistory || displayHistory.length < 2) return accountPerformance;

    // Calculate days for annualization
    const firstDate = new Date(displayHistory[0].valuationDate);
    const lastDate = new Date(displayHistory[displayHistory.length - 1].valuationDate);
    const days = Math.max(1, (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24));
    const years = days / 365;

    // Annualize the TWR
    const annualizedTwr = years > 0 ? Math.pow(1 + frontendSimpleReturn, 1 / years) - 1 : 0;

    // Calculate volatility from daily returns
    let volatility = 0;
    if (displayHistory.length > 2) {
      const dailyReturns: number[] = [];
      for (let i = 1; i < displayHistory.length; i++) {
        const prev = displayHistory[i - 1];
        const curr = displayHistory[i];
        const cf = curr.netContribution - prev.netContribution;
        if (prev.totalValue > 0) {
          const dailyReturn = (curr.totalValue - cf) / prev.totalValue - 1;
          dailyReturns.push(dailyReturn);
        }
      }
      if (dailyReturns.length > 1) {
        const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
        const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (dailyReturns.length - 1);
        volatility = Math.sqrt(variance * 252); // Annualized volatility
      }
    }

    // Calculate max drawdown
    let maxDrawdown = 0;
    let peak = displayHistory[0].totalValue;
    for (const v of displayHistory) {
      if (v.totalValue > peak) peak = v.totalValue;
      const drawdown = peak > 0 ? (peak - v.totalValue) / peak : 0;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return {
      ...accountPerformance,
      cumulativeTwr: frontendSimpleReturn,
      annualizedTwr,
      cumulativeMwr: frontendSimpleReturn, // Use TWR as approximation for MWR
      annualizedMwr: annualizedTwr,
      volatility,
      maxDrawdown,
      currency: "USD",
    };
  }, [showInUsd, accountPerformance, displayHistory, frontendSimpleReturn]);

  const percentageToDisplay = useMemo(() => {
    // When showing in USD, always use frontend-calculated return (from USD-converted history)
    if (showInUsd) {
      return frontendSimpleReturn;
    }
    if (selectedIntervalCode === "ALL") {
      return frontendSimpleReturn;
    }
    // For other intervals, if accountPerformance is available, use cumulativeMwr
    if (accountPerformance) {
      return accountPerformance.cumulativeMwr ?? 0;
    }
    return 0; // Default if no specific logic matches or data is unavailable
  }, [accountPerformance, selectedIntervalCode, frontendSimpleReturn, showInUsd]);

  const handleAccountSwitch = (selectedAccount: Account) => {
    navigate(`/accounts/${selectedAccount.id}`);
    setDesktopSelectorOpen(false);
    setMobileSelectorOpen(false);
  };

  return (
    <Page>
      <PageHeader
        onBack={() => navigate(-1)}
        actions={
          <>
            <div className="hidden items-center gap-2 sm:flex">
              {account?.currency !== "USD" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={showInUsd ? "default" : "outline"}
                      size="icon"
                      onClick={toggleUsdDisplay}
                    >
                      <Icons.DollarSign className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Show values in {showInUsd ? "Account Currency" : "Base Currency"}</p>
                  </TooltipContent>
                </Tooltip>
              )}
              <Button
                variant="outline"
                size="icon"
                onClick={() => navigate(`/import?account=${id}`)}
                title="Import CSV"
              >
                <Icons.Import className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => navigate(`/activities/manage?account=${id}`)}
                title="Record Transaction"
              >
                <Icons.Plus className="h-4 w-4" />
              </Button>
            </div>

            <div className="sm:hidden">
              <MobileActionsMenu
                open={mobileActionsOpen}
                onOpenChange={setMobileActionsOpen}
                title="Account Actions"
                description="Manage this account"
                actions={[
                  ...(account?.currency !== "USD"
                    ? [
                        {
                          icon: "DollarSign" as const,
                          label: showInUsd ? "Show in Account Currency" : "Show in USD",
                          description: showInUsd
                            ? "Display values in original currency"
                            : "Convert all values to USD",
                          onClick: toggleUsdDisplay,
                        },
                      ]
                    : []),
                  {
                    icon: "Import",
                    label: "Import CSV",
                    description: "Import transactions from file",
                    onClick: () => navigate(`/import?account=${id}`),
                  },
                  {
                    icon: "Plus",
                    label: "Record Transaction",
                    description: "Add a new activity manually",
                    onClick: () => navigate(`/activities/manage?account=${id}`),
                  },
                ]}
              />
            </div>
          </>
        }
      >
        <div className="flex flex-col" data-tauri-drag-region="true">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold md:text-xl">{account?.name ?? "Account"}</h1>
            {/* Desktop account selector */}
            <div className="hidden sm:block">
              <Popover open={desktopSelectorOpen} onOpenChange={setDesktopSelectorOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full"
                    aria-label="Switch account"
                  >
                    <Icons.ChevronDown className="text-muted-foreground size-5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[240px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search accounts..." />
                    <CommandList>
                      <CommandEmpty>No accounts found.</CommandEmpty>
                      {accountsByType.map(([type, typeAccounts]) => (
                        <CommandGroup key={type} heading={type}>
                          {typeAccounts.map((acc) => {
                            const IconComponent =
                              accountTypeIcons[acc.accountType] ?? Icons.CreditCard;
                            return (
                              <CommandItem
                                key={acc.id}
                                value={`${acc.name} ${acc.currency}`}
                                onSelect={() => handleAccountSwitch(acc)}
                                className="flex items-center py-1.5"
                              >
                                <IconComponent className="mr-2 h-4 w-4" />
                                <span>
                                  {acc.name} ({acc.currency})
                                </span>
                                <Icons.Check
                                  className={cn(
                                    "ml-auto h-4 w-4",
                                    account?.id === acc.id ? "opacity-100" : "opacity-0",
                                  )}
                                />
                              </CommandItem>
                            );
                          })}
                        </CommandGroup>
                      ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            {/* Mobile account selector */}
            <div className="block sm:hidden">
              <Sheet open={mobileSelectorOpen} onOpenChange={setMobileSelectorOpen}>
                <SheetTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full"
                    aria-label="Switch account"
                  >
                    <Icons.ChevronDown className="text-muted-foreground h-5 w-5" />
                  </Button>
                </SheetTrigger>
                <SheetContent side="bottom" className="mx-1 h-[80vh] rounded-t-4xl p-0">
                  <SheetHeader className="border-border border-b px-6 py-4">
                    <SheetTitle>Switch Account</SheetTitle>
                    <SheetDescription>Choose an account to view</SheetDescription>
                  </SheetHeader>
                  <ScrollArea className="h-[calc(80vh-5rem)] px-6 py-4">
                    <div className="space-y-6">
                      {accountsByType.map(([type, typeAccounts]) => (
                        <div key={type}>
                          <h3 className="text-muted-foreground mb-3 text-sm font-medium">{type}</h3>
                          <div className="space-y-2">
                            {typeAccounts.map((acc) => {
                              const IconComponent =
                                accountTypeIcons[acc.accountType] ?? Icons.CreditCard;
                              return (
                                <button
                                  key={acc.id}
                                  onClick={() => handleAccountSwitch(acc)}
                                  className={cn(
                                    "hover:bg-accent active:bg-accent/80 flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors focus:outline-none",
                                    account?.id === acc.id
                                      ? "border-primary bg-accent"
                                      : "border-transparent",
                                  )}
                                >
                                  <div className="bg-primary/10 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full">
                                    <IconComponent className="text-primary h-5 w-5" />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="text-foreground truncate font-medium">
                                      {acc.name}
                                    </div>
                                    <div className="text-muted-foreground text-sm">
                                      {acc.currency}
                                    </div>
                                  </div>
                                  {account?.id === acc.id && (
                                    <Icons.Check className="text-primary h-5 w-5 flex-shrink-0" />
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </SheetContent>
              </Sheet>
            </div>
          </div>
          <p className="text-muted-foreground text-sm md:text-base">
            {account?.group ?? account?.currency}
          </p>
        </div>
      </PageHeader>
      <PageContent>
        {hasHoldings && !isHoldingsLoading ? (
          <>
            <div className="grid grid-cols-1 gap-4 pt-0 md:grid-cols-3">
              <Card className="col-span-1 md:col-span-2">
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-md">
                    <PortfolioUpdateTrigger lastCalculatedAt={currentValuation?.calculatedAt}>
                      <div className="flex items-start gap-2">
                        <div>
                          <p className="pt-3 text-xl font-bold">
                            <PrivacyAmount
                              value={currentValuation?.totalValue ?? 0}
                              currency={displayCurrency}
                            />
                          </p>
                          <div className="flex space-x-3 text-sm">
                            <GainAmount
                              className="text-sm font-light"
                              value={frontendGainLossAmount}
                              currency={displayCurrency}
                              displayCurrency={false}
                            />
                            <div className="border-muted-foreground my-1 border-r pr-2" />
                            <GainPercent
                              className="text-sm font-light"
                              value={percentageToDisplay}
                              animated={true}
                            />
                          </div>
                        </div>
                        <PrivacyToggle className="mt-3" />
                      </div>
                    </PortfolioUpdateTrigger>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="w-full p-0">
                    <div className="flex w-full flex-col">
                      <div className="h-[480px] w-full">
                        <HistoryChart data={chartData} isLoading={false} />
                        <IntervalSelector
                          className="relative right-0 bottom-10 left-0 z-10"
                          onIntervalSelect={handleIntervalSelect}
                          isLoading={isValuationHistoryLoading}
                          initialSelection={INITIAL_INTERVAL_CODE}
                        />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <div className="flex flex-col space-y-4">
                <AccountMetrics
                  valuation={currentValuation}
                  performance={displayPerformance}
                  className="grow"
                  isLoading={isDetailsLoading || isPerformanceHistoryLoading}
                  displayCurrency={displayCurrency}
                />
                <AccountContributionLimit accountId={id} />
              </div>
            </div>

            <AccountHoldings accountId={id} />
          </>
        ) : (
          <AccountHoldings accountId={id} showEmptyState={true} />
        )}
      </PageContent>
    </Page>
  );
};

export default AccountPage;
