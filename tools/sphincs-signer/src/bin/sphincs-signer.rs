// SPDX-License-Identifier: MIT
//! GhostKey's thin CLI over the vendored leanSphincs-S (keccak256) signer crate.
//!
//! The key is always a pruned key with kept-subtree height `B = 13` (the upstream "Light" tier's `b`), so a seed
//! always maps to exactly one key (upstream rule: "one seed, one key" - never use a seed with two different `b`).
//! The key words equal what upstream `lssk keygen --tier light` / `lssk sign <seed> 13 <msg>` produce for that seed.
//!
//!   sphincs-signer keygen --seed <hex32>              -> {"pkSeed":"0x..","pkRoot":"0x.."}
//!   sphincs-signer sign   --seed <hex32> --msg <hex32> -> {"pkSeed":"0x..","pkRoot":"0x..","message":"0x..","sig":"0x.."}
//!
//! pkSeed / pkRoot are high-aligned (`P || 0^16`, `root || 0^16`), the form `LeanSphincsSAsm.verify` takes.
//! Every signature is checked with the Rust verifier before it is printed. Exit code 1 + message on stderr on error.
//! NOTE: the seed is passed on the command line (visible in the process list); fine for demo/test keys only.

use leansphincs_s_keccak::*;
use std::process::ExitCode;

/// Kept-subtree height. Fixed: changing it would turn every seed into a different (and mutually forgeable) key.
const B: usize = 13;

const USAGE: &str = "usage:\n  sphincs-signer keygen --seed <hex32>\n  sphincs-signer sign --seed <hex32> --msg <hex32>";

fn parse_fixed<const L: usize>(s: &str, what: &str) -> Result<[u8; L], String> {
    let digits = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
    if digits.len() != 2 * L || !digits.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("{what}: expected {L} bytes as hex ({} hex digits, 0x optional)", 2 * L));
    }
    let mut out = [0u8; L];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&digits[2 * i..2 * i + 2], 16).unwrap();
    }
    Ok(out)
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(2 + 2 * bytes.len());
    out.push_str("0x");
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn high_word(value: &[u8; N]) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[..N].copy_from_slice(value);
    word
}

fn flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, String> {
    let pos = args.iter().position(|a| a == name).ok_or_else(|| format!("missing {name}\n{USAGE}"))?;
    args.get(pos + 1).map(String::as_str).ok_or_else(|| format!("{name} needs a value\n{USAGE}"))
}

fn run(args: &[String]) -> Result<String, String> {
    let (command, rest) = args.split_first().ok_or(USAGE)?;
    match command.as_str() {
        "keygen" => {
            let seed: MasterSecret = parse_fixed(flag(rest, "--seed")?, "seed")?;
            let (_, pk) = key_gen(&seed, B);
            Ok(format!(
                "{{\"pkSeed\":\"{}\",\"pkRoot\":\"{}\"}}",
                hex(&high_word(&pk.public_param)),
                hex(&high_word(&pk.root))
            ))
        }
        "sign" => {
            let seed: MasterSecret = parse_fixed(flag(rest, "--seed")?, "seed")?;
            let m: Message = parse_fixed(flag(rest, "--msg")?, "msg")?;
            let (sk, pk) = key_gen(&seed, B);
            let sig = sign(&sk, &m);
            verify(&pk, &m, &sig).map_err(|e| format!("internal error: signature does not verify: {e:?}"))?;
            Ok(format!(
                "{{\"pkSeed\":\"{}\",\"pkRoot\":\"{}\",\"message\":\"{}\",\"sig\":\"{}\"}}",
                hex(&high_word(&pk.public_param)),
                hex(&high_word(&pk.root)),
                hex(&m),
                hex(&sig.to_bytes())
            ))
        }
        _ => Err(USAGE.into()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(out) => {
            println!("{out}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
