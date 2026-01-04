use crate::market_data::market_data_model::DataSource;
use crate::market_data::providers::market_data_provider::MarketDataProvider;
use crate::market_data::{MarketDataError, Quote as ModelQuote};
use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use reqwest::Client;
use rust_decimal::Decimal;
use serde::Deserialize;
use std::time::SystemTime;

const API_URL: &str = "https://www.tefas.gov.tr/api/DB/BindHistoryInfo";
// TEFAS API limitation for historical data
const MAX_HISTORY_DAYS: i64 = 3 * 365;

#[derive(Debug, Deserialize)]
struct TefasHistoryItem {
    #[serde(rename = "TARIH")]
    tarih: serde_json::Value, // Can be string or number
    #[serde(rename = "FIYAT")]
    fiyat: f64, // Price
    #[serde(rename = "TEDPAYSAYISI")]
    tedpaysayisi: Option<f64>, // Number of shares outstanding (volume)
}

#[derive(Debug, Deserialize)]
struct TefasApiResponse {
    data: Option<Vec<TefasHistoryItem>>,
}

pub struct TefasProvider {
    client: Client,
}

impl TefasProvider {
    pub fn new() -> Result<Self, MarketDataError> {
        let client = Client::new();
        Ok(TefasProvider { client })
    }

    #[doc(hidden)]
    pub fn format_date_for_api(date: DateTime<Utc>) -> String {
        date.format("%d.%m.%Y").to_string()
    }

    #[doc(hidden)]
    pub fn parse_timestamp(value: &serde_json::Value) -> i64 {
        match value {
            serde_json::Value::Number(n) => n.as_i64().unwrap_or(0),
            serde_json::Value::String(s) => s.parse::<i64>().unwrap_or(0),
            _ => 0,
        }
    }

    /// Clamp start date to max history limit (TEFAS WAF blocks older requests)
    fn clamp_start_date(start: DateTime<Utc>, end: DateTime<Utc>) -> DateTime<Utc> {
        let min_allowed = end - chrono::Duration::days(MAX_HISTORY_DAYS);
        if start < min_allowed {
            log::info!(
                "TEFAS: Clamping start date from {} to {} (max {} days history)",
                start.format("%Y-%m-%d"),
                min_allowed.format("%Y-%m-%d"),
                MAX_HISTORY_DAYS
            );
            min_allowed
        } else {
            start
        }
    }

    async fn fetch_data(
        &self,
        fund_code: &str,
        start_date: DateTime<Utc>,
        end_date: DateTime<Utc>,
    ) -> Result<Vec<TefasHistoryItem>, MarketDataError> {
        let start_str = Self::format_date_for_api(start_date);
        let end_str = Self::format_date_for_api(end_date);

        log::debug!(
            "TEFAS: Fetching {} from {} to {}",
            fund_code,
            start_str,
            end_str
        );

        // Build form body
        let form_data = [
            ("fontip", "YAT"),
            ("sfontur", ""),
            ("fonkod", fund_code),
            ("fongrup", ""),
            ("bastarih", &start_str),
            ("bittarih", &end_str),
            ("fonturkod", ""),
            ("fonunvantip", ""),
            ("kurucukod", ""),
        ];

        let response = self
            .client
            .post(API_URL)
            .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0")
            .header("Accept", "application/json, text/javascript, */*; q=0.01")
            .header("Accept-Language", "en-US,en;q=0.5")
            .header("X-Requested-With", "XMLHttpRequest")
            .header("Origin", "https://www.tefas.gov.tr")
            .header("Referer", "https://www.tefas.gov.tr/TarihselVeriler.aspx")
            .form(&form_data)
            .send()
            .await
            .map_err(|e| MarketDataError::ProviderError(format!("Request failed: {}", e)))?;

        let text = response
            .text()
            .await
            .map_err(|e| MarketDataError::ProviderError(format!("Failed to read response: {}", e)))?;

        // Check for empty response
        if text.is_empty() {
            log::warn!("TEFAS returned empty response for {}", fund_code);
            return Err(MarketDataError::ProviderError(
                "Empty response from TEFAS API".to_string(),
            ));
        }

        // Check if response looks like HTML (error page)
        if text.trim_start().starts_with('<') {
            log::warn!(
                "TEFAS returned HTML instead of JSON for {} - Response: {}",
                fund_code,
                &text[..text.len().min(200)]
            );
            return Err(MarketDataError::ProviderError(
                "TEFAS API returned error page".to_string(),
            ));
        }

        // Parse JSON
        let result: TefasApiResponse = serde_json::from_str(&text).map_err(|e| {
            log::debug!(
                "TEFAS JSON parse error for {}: {} - Response: {}",
                fund_code,
                e,
                &text[..text.len().min(200)]
            );
            MarketDataError::ProviderError(format!("JSON parse error: {}", e))
        })?;

        let data = result.data.unwrap_or_default();
        log::debug!(
            "TEFAS: Received {} quotes for {} ({} - {})",
            data.len(),
            fund_code,
            start_str,
            end_str
        );

        Ok(data)
    }

    fn convert_to_quote(item: &TefasHistoryItem, symbol: &str) -> ModelQuote {
        let timestamp_ms = Self::parse_timestamp(&item.tarih);
        let quote_timestamp: DateTime<Utc> = Utc
            .timestamp_millis_opt(timestamp_ms)
            .single()
            .unwrap_or_default();

        let price = Decimal::from_f64_retain(item.fiyat).unwrap_or_default();
        let volume =
            Decimal::from_f64_retain(item.tedpaysayisi.unwrap_or(0.0)).unwrap_or_default();

        ModelQuote {
            id: format!("{}_{}", quote_timestamp.format("%Y%m%d"), symbol),
            created_at: Utc::now(),
            data_source: DataSource::Tefas,
            timestamp: quote_timestamp,
            symbol: symbol.to_string(),
            open: price,
            high: price,
            low: price,
            close: price,
            adjclose: price,
            volume,
            currency: "TRY".to_string(),
        }
    }
}

#[async_trait]
impl MarketDataProvider for TefasProvider {
    fn name(&self) -> &'static str {
        "TEFAS"
    }

    fn priority(&self) -> u8 {
        5
    }

    async fn get_latest_quote(
        &self,
        symbol: &str,
        _fallback_currency: String,
    ) -> Result<ModelQuote, MarketDataError> {
        log::info!("TEFAS: Fetching latest quote for {}", symbol);

        let today = Utc::now();
        let yesterday = today - chrono::Duration::days(1);

        let data = self.fetch_data(symbol, yesterday, today).await?;

        if data.is_empty() {
            log::warn!("TEFAS: No data found for {}", symbol);
            return Err(MarketDataError::NoData);
        }

        // Get the most recent quote (highest timestamp)
        let latest = data
            .iter()
            .max_by_key(|item| Self::parse_timestamp(&item.tarih))
            .ok_or(MarketDataError::NoData)?;

        let quote = Self::convert_to_quote(latest, symbol);
        log::info!(
            "TEFAS: Got latest quote for {} - price: {}, date: {}",
            symbol,
            quote.close,
            quote.timestamp.format("%Y-%m-%d")
        );

        Ok(quote)
    }

    async fn get_historical_quotes(
        &self,
        symbol: &str,
        start: SystemTime,
        end: SystemTime,
        _fallback_currency: String,
    ) -> Result<Vec<ModelQuote>, MarketDataError> {
        let end_date = DateTime::<Utc>::from(end);
        let mut start_date = Self::clamp_start_date(DateTime::<Utc>::from(start), end_date);

        // Ensure minimum 30 days lookback to handle weekends/holidays
        let min_lookback = end_date - chrono::Duration::days(30);
        if start_date > min_lookback {
            log::debug!(
                "TEFAS: Extending lookback from {} to {} (minimum 30 days)",
                start_date.format("%Y-%m-%d"),
                min_lookback.format("%Y-%m-%d")
            );
            start_date = min_lookback;
        }

        log::info!(
            "TEFAS: Fetching historical quotes for {} from {} to {}",
            symbol,
            start_date.format("%Y-%m-%d"),
            end_date.format("%Y-%m-%d")
        );

        let mut all_quotes = Vec::new();
        let max_days = chrono::Duration::days(90);

        // Fetch in 90-day chunks (TEFAS API limitation)
        let mut current_start = start_date;
        while current_start < end_date {
            let mut current_end = current_start + max_days;
            if current_end > end_date {
                current_end = end_date;
            }

            let data = self.fetch_data(symbol, current_start, current_end).await?;

            for item in &data {
                all_quotes.push(Self::convert_to_quote(item, symbol));
            }

            current_start = current_end + chrono::Duration::days(1);

            // Small delay to be nice to the API
            if current_start < end_date {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
        }

        log::info!(
            "TEFAS: Fetched {} historical quotes for {}",
            all_quotes.len(),
            symbol
        );

        Ok(all_quotes)
    }

    async fn get_historical_quotes_bulk(
        &self,
        symbols_with_currencies: &[(String, String)],
        start: SystemTime,
        end: SystemTime,
    ) -> Result<(Vec<ModelQuote>, Vec<(String, String)>), MarketDataError> {
        let end_date = DateTime::<Utc>::from(end);
        let mut start_date = Self::clamp_start_date(DateTime::<Utc>::from(start), end_date);

        // Ensure minimum 30 days lookback to handle weekends/holidays
        let min_lookback = end_date - chrono::Duration::days(30);
        if start_date > min_lookback {
            log::debug!(
                "TEFAS: Extending lookback from {} to {} (minimum 30 days)",
                start_date.format("%Y-%m-%d"),
                min_lookback.format("%Y-%m-%d")
            );
            start_date = min_lookback;
        }

        let max_days = chrono::Duration::days(90);

        log::info!(
            "TEFAS: Bulk fetching {} symbols from {} to {}",
            symbols_with_currencies.len(),
            start_date.format("%Y-%m-%d"),
            end_date.format("%Y-%m-%d")
        );

        let mut all_quotes = Vec::new();
        let mut failed_symbols: Vec<(String, String)> = Vec::new();
        let mut errors_for_logging: Vec<(String, String)> = Vec::new();

        // Process symbols sequentially to avoid overwhelming the API
        for (idx, (symbol, currency)) in symbols_with_currencies.iter().enumerate() {
            log::debug!(
                "TEFAS: Processing symbol {}/{}: {}",
                idx + 1,
                symbols_with_currencies.len(),
                symbol
            );
            let mut symbol_quotes = Vec::new();
            let mut current_start = start_date;
            let mut had_error = false;

            while current_start < end_date {
                let mut current_end = current_start + max_days;
                if current_end > end_date {
                    current_end = end_date;
                }

                match self.fetch_data(symbol, current_start, current_end).await {
                    Ok(data) => {
                        for item in &data {
                            symbol_quotes.push(Self::convert_to_quote(item, symbol));
                        }
                    }
                    Err(e) => {
                        had_error = true;
                        errors_for_logging.push((symbol.clone(), e.to_string()));
                        break;
                    }
                }

                current_start = current_end + chrono::Duration::days(1);

                // Small delay between requests
                if current_start < end_date {
                    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                }
            }

            if had_error {
                failed_symbols.push((symbol.clone(), currency.clone()));
            } else {
                all_quotes.extend(symbol_quotes);
            }

            // Delay between symbols
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        }

        if !errors_for_logging.is_empty() {
            log::warn!(
                "TEFAS: Failed to fetch history for {} symbols: {:?}",
                errors_for_logging.len(),
                errors_for_logging
            );
        }

        log::info!(
            "TEFAS: Bulk fetch complete - {} quotes from {} symbols, {} failed",
            all_quotes.len(),
            symbols_with_currencies.len() - failed_symbols.len(),
            failed_symbols.len()
        );

        Ok((all_quotes, failed_symbols))
    }
}
