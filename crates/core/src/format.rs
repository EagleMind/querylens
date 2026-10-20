//! Human-readable numbers for finding titles and details. Mirrors
//! `cloud/web/lib/format.ts` in the dashboard.

pub fn fmt_ms(ms: f64) -> String {
    // An empty sum is -0.0.
    let ms = if ms == 0.0 { 0.0 } else { ms };
    if ms >= 1000.0 {
        format!("{:.2} s", ms / 1000.0)
    } else if ms >= 10.0 {
        format!("{ms:.0} ms")
    } else {
        format!("{ms:.2} ms")
    }
}

/// 1234 → "1.2k", 2_500_000 → "2.5M".
pub fn fmt_count(n: f64) -> String {
    let abs = n.abs();
    if abs >= 1e9 {
        format!("{:.1}B", n / 1e9)
    } else if abs >= 1e6 {
        format!("{:.1}M", n / 1e6)
    } else if abs >= 1e4 {
        format!("{:.0}k", n / 1e3)
    } else if abs >= 1e3 {
        format!("{:.1}k", n / 1e3)
    } else {
        format!("{n:.0}")
    }
}

pub fn fmt_bytes(b: f64) -> String {
    const UNITS: [&str; 5] = ["B", "kB", "MB", "GB", "TB"];
    let mut v = b;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if v >= 10.0 || i == 0 { format!("{v:.0} {}", UNITS[i]) } else { format!("{v:.1} {}", UNITS[i]) }
}

/// Share 0–1 → "42%", "3.5%", "<0.1%".
pub fn fmt_pct(share: f64) -> String {
    let p = share * 100.0;
    if p >= 10.0 {
        format!("{p:.0}%")
    } else if p >= 0.1 {
        format!("{p:.1}%")
    } else if p == 0.0 {
        "0%".into()
    } else {
        "<0.1%".into()
    }
}
