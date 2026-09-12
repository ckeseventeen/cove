use reqwest::Client;
use std::sync::OnceLock;
use std::time::Duration;

/// Standard HTTP client with proxy support and default timeout.
pub fn http() -> &'static Client {
    static INSTANCE: OnceLock<Client> = OnceLock::new();
    INSTANCE.get_or_init(|| {
        Client::builder()
            .user_agent("Nimbus/0.2")
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build HTTP client")
    })
}

/// Direct HTTP client that bypasses system proxy.
pub fn direct_http() -> &'static Client {
    static INSTANCE: OnceLock<Client> = OnceLock::new();
    INSTANCE.get_or_init(|| {
        Client::builder()
            .no_proxy()
            .user_agent("Nimbus/0.2")
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build direct HTTP client")
    })
}

/// Long-timeout HTTP client for large transfers.
pub fn transfer_http() -> &'static Client {
    static INSTANCE: OnceLock<Client> = OnceLock::new();
    INSTANCE.get_or_init(|| {
        Client::builder()
            .user_agent("pan.baidu.com")
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .build()
            .expect("failed to build transfer HTTP client")
    })
}

/// Direct HTTP client with long-timeout for large transfers.
pub fn direct_transfer_http() -> &'static Client {
    static INSTANCE: OnceLock<Client> = OnceLock::new();
    INSTANCE.get_or_init(|| {
        Client::builder()
            .no_proxy()
            .user_agent("pan.baidu.com")
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .build()
            .expect("failed to build direct transfer HTTP client")
    })
}

/// Metadata HTTP client with shorter timeout.
pub fn metadata_http() -> &'static Client {
    static INSTANCE: OnceLock<Client> = OnceLock::new();
    INSTANCE.get_or_init(|| {
        Client::builder()
            .user_agent("Nimbus/0.2")
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(15))
            .build()
            .expect("failed to build metadata HTTP client")
    })
}

/// Metadata direct HTTP client with shorter timeout.
pub fn metadata_direct_http() -> &'static Client {
    static INSTANCE: OnceLock<Client> = OnceLock::new();
    INSTANCE.get_or_init(|| {
        Client::builder()
            .no_proxy()
            .user_agent("Nimbus/0.2")
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(8))
            .build()
            .expect("failed to build metadata direct HTTP client")
    })
}
