//! GhostKey `bsgs`: baby-step giant-step recovery of a small secp256k1 scalar.
//!
//! Recovers a private key k in [1, 2^N) from its public key in ~O(2^(N/2))
//! group operations. Powers the "our quantum computer is a laptop" demo.

use std::collections::HashMap;
use std::time::Instant;

use elliptic_curve::group::Curve as _; // brings batch_normalize into scope
use elliptic_curve::group::Group as _; // brings is_identity into scope
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::{AffinePoint, ProjectivePoint, PublicKey, Scalar};
use rayon::prelude::*;
use sha3::{Digest, Keccak256};

const BATCH: usize = 4096;

/// 8-byte fingerprint of a point's affine x-coordinate (None for identity).
#[inline]
fn fingerprint(a: &AffinePoint) -> Option<u64> {
    let ep = a.to_encoded_point(false);
    ep.x()
        .map(|x| u64::from_be_bytes(x[0..8].try_into().unwrap()))
}

/// Walk `count` points starting at `start`, adding `step` each time, batch
/// normalizing to affine, invoking `f(index, fingerprint)` for each.
fn walk<F: FnMut(usize, Option<u64>)>(
    start: ProjectivePoint,
    step: ProjectivePoint,
    count: usize,
    mut f: F,
) {
    let mut cur = start;
    let mut i = 0usize;
    let mut proj: Vec<ProjectivePoint> = Vec::with_capacity(BATCH);
    let mut is_id: Vec<bool> = Vec::with_capacity(BATCH);
    while i < count {
        let len = std::cmp::min(BATCH, count - i);
        proj.clear();
        is_id.clear();
        for _ in 0..len {
            // batch_normalize chokes on the identity (Z=0); substitute the
            // generator as a placeholder and report the slot as identity.
            let id = bool::from(cur.is_identity());
            is_id.push(id);
            proj.push(if id { ProjectivePoint::GENERATOR } else { cur });
            cur += step;
        }
        let mut aff = vec![AffinePoint::default(); len];
        ProjectivePoint::batch_normalize(&proj, &mut aff);
        for (t, a) in aff.iter().enumerate() {
            let fp = if is_id[t] { None } else { fingerprint(a) };
            f(i + t, fp);
        }
        i += len;
    }
}

/// Split `total` into roughly equal contiguous (start, len) ranges.
fn ranges(total: u64, parts: usize) -> Vec<(u64, u64)> {
    let parts = parts.max(1) as u64;
    let chunk = total.div_ceil(parts);
    let mut v = Vec::new();
    let mut s = 0u64;
    while s < total {
        let len = chunk.min(total - s);
        v.push((s, len));
        s += len;
    }
    v
}

#[inline]
fn pubkey_of(k: u64) -> ProjectivePoint {
    ProjectivePoint::GENERATOR * Scalar::from(k)
}

/// Recover the scalar k in [1, 2^n) with k*G == target, or None.
fn crack_scalar(target: ProjectivePoint, n: u32) -> Option<u64> {
    let half = n.div_ceil(2); // ceil(n/2)
    let m: u64 = 1u64 << half; // baby-step count / giant stride
    let giant_count: u64 = (1u64 << (n - half)) + 1; // 2^floor(n/2) + 1 (inclusive)

    let g = ProjectivePoint::GENERATOR;
    let w = g * Scalar::from(m); // m*G, the giant stride
    let neg_w = -w;

    let threads = rayon::current_num_threads();

    // --- Baby steps: build fingerprint -> j table in parallel. ---
    let baby_ranges = ranges(m, threads * 4);
    let partials: Vec<Vec<(u64, u32)>> = baby_ranges
        .par_iter()
        .map(|&(s, c)| {
            let start = g * Scalar::from(s);
            let mut v: Vec<(u64, u32)> = Vec::with_capacity(c as usize);
            walk(start, g, c as usize, |idx, fp| {
                if let Some(x) = fp {
                    v.push((x, s as u32 + idx as u32));
                }
            });
            v
        })
        .collect();

    let mut table: HashMap<u64, u32> = HashMap::with_capacity(m as usize);
    for v in partials {
        for (fp, j) in v {
            table.insert(fp, j);
        }
    }

    // --- Giant steps: scan P - i*(m*G) for a baby-step collision. ---
    let giant_ranges = ranges(giant_count, threads * 4);
    giant_ranges.par_iter().find_map_any(|&(s, c)| {
        let start = target - (w * Scalar::from(s));
        let mut found: Option<u64> = None;
        walk(start, neg_w, c as usize, |idx, fp| {
            if found.is_some() {
                return;
            }
            let i = s + idx as u64;
            match fp {
                // Identity => P == i*W => k = i*m (j = 0).
                None => {
                    let cand = i.wrapping_mul(m);
                    if cand >= 1 && pubkey_of(cand) == target {
                        found = Some(cand);
                    }
                }
                Some(x) => {
                    if let Some(&j) = table.get(&x) {
                        let cand = i * m + j as u64;
                        if cand >= 1 && pubkey_of(cand) == target {
                            found = Some(cand);
                        }
                    }
                }
            }
        });
        found
    })
}

fn scalar_to_hex(k: u64) -> String {
    let s = Scalar::from(k);
    format!("0x{}", hex::encode(s.to_bytes()))
}

/// EIP-55 checksummed Ethereum address from an uncompressed public key point.
fn address_of(point: ProjectivePoint) -> String {
    let ep = point.to_affine().to_encoded_point(false);
    let bytes = ep.as_bytes(); // 65 bytes: 0x04 || X || Y
    let hash = Keccak256::digest(&bytes[1..]); // keccak over X||Y (drop 0x04)
    let addr = &hash[12..]; // last 20 bytes
    let lower = hex::encode(addr);
    let cs = Keccak256::digest(lower.as_bytes());
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (i, ch) in lower.chars().enumerate() {
        if ch.is_ascii_digit() {
            out.push(ch);
        } else {
            let nib = if i % 2 == 0 { cs[i / 2] >> 4 } else { cs[i / 2] & 0xf };
            out.push(if nib >= 8 { ch.to_ascii_uppercase() } else { ch });
        }
    }
    out
}

fn uncompressed_hex(point: ProjectivePoint) -> String {
    let ep = point.to_affine().to_encoded_point(false);
    format!("0x{}", hex::encode(ep.as_bytes()))
}

fn parse_point(s: &str) -> Result<ProjectivePoint, String> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(s).map_err(|e| format!("invalid hex pubkey: {e}"))?;
    let pk = PublicKey::from_sec1_bytes(&bytes)
        .map_err(|e| format!("invalid sec1 pubkey ({} bytes): {e}", bytes.len()))?;
    Ok(pk.to_projective())
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn die(msg: &str) -> ! {
    println!("{{\"error\":\"{}\"}}", msg.replace('"', "'"));
    std::process::exit(1);
}

/// Minimal `--flag value` extraction.
fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
}

fn cmd_gen(args: &[String]) {
    let bits: u32 = flag(args, "--bits")
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| die("gen requires --bits <N>"));
    if !(1..=63).contains(&bits) {
        die("bits must be in 1..=63");
    }
    let seed = flag(args, "--seed").and_then(|s| s.parse::<u64>().ok());
    let mut state = seed.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x1234_5678)
    });
    let mask = if bits == 64 { u64::MAX } else { (1u64 << bits) - 1 };
    let mut k = splitmix64(&mut state) & mask;
    if k == 0 {
        k = 1;
    }
    let point = pubkey_of(k);
    println!(
        "{{\"privateKey\":\"{}\",\"pubkey\":\"{}\",\"address\":\"{}\"}}",
        scalar_to_hex(k),
        uncompressed_hex(point),
        address_of(point)
    );
}

fn cmd_crack(args: &[String]) {
    let bits: u32 = flag(args, "--bits")
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| die("crack requires --bits <N>"));
    if !(1..=48).contains(&bits) {
        die("bits must be in 1..=48");
    }
    let pubkey = flag(args, "--pubkey").unwrap_or_else(|| die("crack requires --pubkey <hex>"));
    let point = match parse_point(pubkey) {
        Ok(p) => p,
        Err(e) => die(&e),
    };
    let t0 = Instant::now();
    match crack_scalar(point, bits) {
        Some(k) => {
            let ms = t0.elapsed().as_millis();
            println!(
                "{{\"privateKey\":\"{}\",\"address\":\"{}\",\"ms\":{},\"bits\":{}}}",
                scalar_to_hex(k),
                address_of(point),
                ms,
                bits
            );
        }
        None => die("key not found within 2^bits"),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("crack") => cmd_crack(&args[2..]),
        Some("gen") => cmd_gen(&args[2..]),
        _ => {
            eprintln!("usage:");
            eprintln!("  bsgs gen   --bits <N> [--seed <u64>]");
            eprintln!("  bsgs crack --pubkey <hex> --bits <N>");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(n: u32, seed: u64) {
        let mut state = seed;
        let mask = (1u64 << n) - 1;
        let mut k = splitmix64(&mut state) & mask;
        if k == 0 {
            k = 1;
        }
        let p = pubkey_of(k);
        let recovered = crack_scalar(p, n).expect("should recover");
        assert_eq!(recovered, k, "n={n} seed={seed}");
    }

    #[test]
    fn roundtrip_n20() {
        for seed in 0..5 {
            roundtrip(20, seed);
        }
    }

    #[test]
    fn roundtrip_n28() {
        for seed in 0..3 {
            roundtrip(28, seed);
        }
    }

    #[test]
    fn edge_k_equals_one() {
        assert_eq!(crack_scalar(pubkey_of(1), 20), Some(1));
    }

    #[test]
    fn edge_multiple_of_m() {
        // k = m (j == 0 path): for n=20, m = 2^10 = 1024.
        assert_eq!(crack_scalar(pubkey_of(1024), 20), Some(1024));
    }

    #[test]
    fn address_known_vector() {
        // Private key 1 -> well-known address.
        let addr = address_of(pubkey_of(1));
        assert_eq!(
            addr.to_lowercase(),
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
    }
}
