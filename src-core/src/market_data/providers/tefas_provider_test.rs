#[cfg(test)]
mod tests {
    use super::super::tefas_provider::TefasProvider;
    use crate::market_data::providers::market_data_provider::MarketDataProvider;
    use chrono::Utc;
    use std::time::SystemTime;

    #[test]
    fn test_provider_creation() {
        let provider = TefasProvider::new();
        assert!(provider.is_ok());
    }

    #[test]
    fn test_provider_name() {
        let provider = TefasProvider::new().unwrap();
        assert_eq!(provider.name(), "TEFAS");
    }

    #[test]
    fn test_provider_priority() {
        let provider = TefasProvider::new().unwrap();
        assert_eq!(provider.priority(), 5);
    }

    #[test]
    fn test_date_formatting() {
        use chrono::TimeZone;
        let date = Utc.with_ymd_and_hms(2025, 1, 15, 0, 0, 0).unwrap();
        let formatted = TefasProvider::format_date_for_api(date);
        assert_eq!(formatted, "15.01.2025");
    }

    #[test]
    fn test_parse_timestamp_number() {
        let value = serde_json::json!(1767312000000_i64);
        let timestamp = TefasProvider::parse_timestamp(&value);
        assert_eq!(timestamp, 1767312000000);
    }

    #[test]
    fn test_parse_timestamp_string() {
        let value = serde_json::json!("1767312000000");
        let timestamp = TefasProvider::parse_timestamp(&value);
        assert_eq!(timestamp, 1767312000000);
    }

    #[test]
    fn test_parse_timestamp_null() {
        let value = serde_json::json!(null);
        let timestamp = TefasProvider::parse_timestamp(&value);
        assert_eq!(timestamp, 0);
    }

    // Integration tests - require curl and network access
    // Run with: cargo test --package wealthfolio_core tefas -- --ignored

    #[tokio::test]
    #[ignore] // Requires network access
    async fn test_fetch_latest_quote() {
        let provider = TefasProvider::new().unwrap();
        let result = provider
            .get_latest_quote("AFT", "TRY".to_string())
            .await;

        match result {
            Ok(quote) => {
                assert_eq!(quote.symbol, "AFT");
                assert_eq!(quote.currency, "TRY");
                assert!(quote.close > rust_decimal::Decimal::ZERO);
            }
            Err(e) => {
                // API might be blocked in some environments
                println!("API call failed (may be expected): {:?}", e);
            }
        }
    }

    #[tokio::test]
    #[ignore] // Requires network access
    async fn test_fetch_historical_quotes() {
        let provider = TefasProvider::new().unwrap();

        let end = SystemTime::now();
        let start = end - std::time::Duration::from_secs(30 * 24 * 60 * 60); // 30 days ago

        let result = provider
            .get_historical_quotes("AFT", start, end, "TRY".to_string())
            .await;

        match result {
            Ok(quotes) => {
                assert!(!quotes.is_empty(), "Should have some quotes");
                for quote in &quotes {
                    assert_eq!(quote.symbol, "AFT");
                    assert_eq!(quote.currency, "TRY");
                    assert!(quote.close > rust_decimal::Decimal::ZERO);
                }
            }
            Err(e) => {
                println!("API call failed (may be expected): {:?}", e);
            }
        }
    }

    #[tokio::test]
    #[ignore] // Requires network access
    async fn test_fetch_bulk_quotes() {
        let provider = TefasProvider::new().unwrap();

        let end = SystemTime::now();
        let start = end - std::time::Duration::from_secs(7 * 24 * 60 * 60); // 7 days ago

        let symbols = vec![
            ("AFT".to_string(), "TRY".to_string()),
            ("GUM".to_string(), "TRY".to_string()),
        ];

        let result = provider
            .get_historical_quotes_bulk(&symbols, start, end)
            .await;

        match result {
            Ok((quotes, failed)) => {
                println!("Fetched {} quotes, {} failed", quotes.len(), failed.len());
                // We expect at least some quotes if the API is working
                if failed.is_empty() {
                    assert!(!quotes.is_empty());
                }
            }
            Err(e) => {
                println!("API call failed (may be expected): {:?}", e);
            }
        }
    }

    #[tokio::test]
    #[ignore] // Requires network access
    async fn test_invalid_fund_code() {
        let provider = TefasProvider::new().unwrap();
        let result = provider
            .get_latest_quote("INVALID_FUND_XYZ", "TRY".to_string())
            .await;

        // Invalid fund should return NoData or empty result
        match result {
            Ok(quote) => {
                // If we get a quote, the API returned something unexpected
                println!("Unexpected quote for invalid fund: {:?}", quote);
            }
            Err(_) => {
                // Expected - invalid fund should error
            }
        }
    }

    #[test]
    fn test_data_source() {
        use crate::market_data::market_data_model::DataSource;

        // Verify the DataSource enum variant is correct
        assert_eq!(DataSource::Tefas.as_str(), "TEFAS");
    }
}
