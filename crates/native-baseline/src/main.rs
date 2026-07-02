//! Native floor for the differential perf harness.
//!
//! Runs one logical op many times, timing each with a monotonic clock, and emits
//! the raw per-iteration sample array (nanoseconds) as JSON to stdout. The TypeScript
//! harness reduces these samples with the SAME `stats()` it applies to the node and
//! guest layers, so the percentile math is identical across all three layers and the
//! "emulation tax" ratio is honest.
//!
//! Ops (held byte-identical to the node + guest layers):
//!   spawn_exit    -> /bin/sh -c 'exit 0'      (fork/posix_spawn + execve + reap)
//!   exec_capture  -> /bin/sh -c 'printf hi'   (same, plus stdout capture)
//!   fs_stat       -> stat a small host file
//!   fs_write      -> overwrite a small host file
//!   fs_read       -> read a 64 KiB host file
//!   dns_lookup    -> resolve localhost
//!   tcp_connect   -> localhost TCP connect+close
//!   tcp_echo      -> localhost TCP connect+echo
//!   pipe_echo     -> shell pipe echo through cat
//!   cpu_loop      -> bounded integer loop
//!   alloc_free    -> allocate/drop a 64 KiB Vec
//!
//! Usage: native-baseline --op spawn_exit|exec_capture --iters N --warmup W

use std::fs::File;
#[cfg(not(target_family = "wasm"))]
use std::io::Read;
use std::io::Write;
#[cfg(not(target_family = "wasm"))]
use std::net::{TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
#[cfg(all(unix, not(target_family = "wasm")))]
use std::os::unix::net::UnixStream;
use std::path::Path;
#[cfg(not(target_family = "wasm"))]
use std::process::{Command, Stdio};
#[cfg(not(target_family = "wasm"))]
use std::thread;
use std::time::Instant;
#[cfg(target_family = "wasm")]
use std::time::SystemTime;

#[derive(Clone, Copy)]
enum Op {
    SpawnExit,
    ExecCapture,
    NodeStdoutDiscard2b,
    NodeStdoutCapture2b,
    NodeStdoutListenerOnly2b,
    NodeExit,
    NodeFanout,
    NodeReapStorm,
    PipeChain,
    FsStat,
    FsWrite,
    FsRead,
    FsOpenClose,
    FsMkdirRmdir,
    FsRename,
    FsReaddir,
    FsFsync,
    DnsLookup,
    DnsConcurrent,
    TcpConnect,
    TcpEcho,
    TcpConcurrent,
    TcpThroughput,
    TcpTinyWrites,
    UdpEcho,
    PipeEcho,
    PipeThroughput,
    PipeBackpressure,
    CpuLoop,
    AllocFree,
}

struct BenchConfig {
    size_bytes: Option<usize>,
    entry_count: Option<usize>,
}

impl Op {
    #[cfg(target_family = "wasm")]
    fn supported_on_wasm(self) -> bool {
        matches!(
            self,
            Op::FsStat
                | Op::FsWrite
                | Op::FsRead
                | Op::FsOpenClose
                | Op::FsMkdirRmdir
                | Op::FsRename
                | Op::FsReaddir
                | Op::FsFsync
                | Op::CpuLoop
                | Op::AllocFree
        )
    }
}

#[cfg(not(target_family = "wasm"))]
type Timer = Instant;

#[cfg(not(target_family = "wasm"))]
fn timer_start() -> Timer {
    Instant::now()
}

#[cfg(not(target_family = "wasm"))]
fn elapsed_ns(timer: Timer) -> u128 {
    timer.elapsed().as_nanos()
}

#[cfg(target_family = "wasm")]
struct Timer {
    instant: Option<Instant>,
    system: SystemTime,
}

#[cfg(target_family = "wasm")]
fn timer_start() -> Timer {
    Timer {
        instant: std::panic::catch_unwind(Instant::now).ok(),
        system: SystemTime::now(),
    }
}

#[cfg(target_family = "wasm")]
fn elapsed_ns(timer: Timer) -> u128 {
    if let Some(instant) = timer.instant {
        if let Ok(elapsed) = std::panic::catch_unwind(|| instant.elapsed()) {
            return elapsed.as_nanos();
        }
    }
    timer.system.elapsed().map(|d| d.as_nanos()).unwrap_or(0)
}

fn run_once(op: Op, iter: usize, base_dir: &Path, config: &BenchConfig) {
    match op {
        #[cfg(not(target_family = "wasm"))]
        Op::SpawnExit => {
            let status = Command::new("/bin/sh")
                .args(["-c", "exit 0"])
                .status()
                .expect("spawn /bin/sh failed");
            assert!(status.success(), "expected exit 0, got {status:?}");
        }
        #[cfg(not(target_family = "wasm"))]
        Op::ExecCapture => {
            let out = Command::new("/bin/sh")
                .args(["-c", "printf hi"])
                .output()
                .expect("spawn /bin/sh failed");
            assert_eq!(out.stdout, b"hi", "unexpected stdout");
        }
        #[cfg(not(target_family = "wasm"))]
        Op::NodeStdoutDiscard2b => {
            let size_bytes = config.size_bytes.unwrap_or(2);
            let script = format!("process.stdout.write(Buffer.alloc({size_bytes}, 55))");
            let status = Command::new("node")
                .arg("-e")
                .arg(&script)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("spawn node failed");
            assert!(status.success(), "expected exit 0, got {status:?}");
        }
        #[cfg(not(target_family = "wasm"))]
        Op::NodeStdoutCapture2b => {
            let size_bytes = config.size_bytes.unwrap_or(2);
            let script = format!("process.stdout.write(Buffer.alloc({size_bytes}, 55))");
            let out = Command::new("node")
                .arg("-e")
                .arg(&script)
                .output()
                .expect("spawn node failed");
            assert!(
                out.status.success(),
                "expected exit 0, got {:?}",
                out.status
            );
            assert_eq!(out.stdout.len(), size_bytes, "unexpected stdout byte count");
        }
        #[cfg(not(target_family = "wasm"))]
        Op::NodeStdoutListenerOnly2b => {
            let size_bytes = config.size_bytes.unwrap_or(2);
            let script = format!("process.stdout.write(Buffer.alloc({size_bytes}, 55))");
            let mut child = Command::new("node")
                .arg("-e")
                .arg(&script)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn node failed");
            let mut stdout = child.stdout.take().expect("stdout pipe");
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).expect("read stdout");
            let status = child.wait().expect("wait node child");
            assert!(status.success(), "expected exit 0, got {status:?}");
            assert_eq!(bytes.len(), size_bytes, "unexpected stdout byte count");
        }
        // Real host node process that immediately exits. This is the apples-to-apples
        // floor for the guest layer, where the same logical op spins a V8 isolate.
        #[cfg(not(target_family = "wasm"))]
        Op::NodeExit => {
            let status = Command::new("node")
                .args(["-e", "process.exit(0)"])
                .status()
                .expect("spawn node failed");
            assert!(status.success(), "expected exit 0, got {status:?}");
        }
        #[cfg(not(target_family = "wasm"))]
        Op::NodeFanout | Op::NodeReapStorm => {
            let mut children = Vec::new();
            for _ in 0..8 {
                children.push(
                    Command::new("node")
                        .args(["-e", "process.exit(0)"])
                        .spawn()
                        .expect("spawn node failed"),
                );
            }
            for mut child in children {
                let status = child.wait().expect("wait node child");
                assert!(status.success(), "expected exit 0, got {status:?}");
            }
        }
        #[cfg(not(target_family = "wasm"))]
        Op::PipeChain => {
            let out = Command::new("/bin/sh")
                .args(["-c", "printf hello | cat | cat >/dev/null"])
                .output()
                .expect("run pipe chain");
            assert!(out.status.success(), "pipe chain failed: {out:?}");
        }
        Op::FsStat => {
            let path = base_dir.join("secure-exec-native-fs-stat.txt");
            std::fs::write(&path, b"hi").expect("write stat fixture");
            let meta = std::fs::metadata(&path).expect("stat fixture");
            assert!(meta.len() >= 2);
        }
        Op::FsWrite => {
            let path = base_dir.join("secure-exec-native-fs-write.txt");
            if let Some(size_bytes) = config.size_bytes {
                std::fs::write(path, vec![(iter & 255) as u8; size_bytes]).expect("write fixture");
            } else {
                std::fs::write(path, format!("hello-{iter:08}")).expect("write fixture");
            }
        }
        Op::FsRead => {
            let size_bytes = config.size_bytes.unwrap_or(64 * 1024);
            let path = base_dir.join("secure-exec-native-fs-read.bin");
            let rewrite = std::fs::metadata(&path)
                .map(|meta| meta.len() != size_bytes as u64)
                .unwrap_or(true);
            if rewrite {
                std::fs::write(&path, vec![7_u8; size_bytes]).expect("write read fixture");
            }
            let data = std::fs::read(path).expect("read fixture");
            assert_eq!(data.len(), size_bytes);
        }
        Op::FsOpenClose => {
            let path = base_dir.join("secure-exec-native-fs-open-close.txt");
            std::fs::write(&path, b"hi").expect("write open fixture");
            let file = File::open(path).expect("open fixture");
            drop(file);
        }
        Op::FsMkdirRmdir => {
            let path = base_dir.join(format!("secure-exec-native-dir-{iter}"));
            std::fs::create_dir(&path).expect("create dir");
            std::fs::remove_dir(&path).expect("remove dir");
        }
        Op::FsRename => {
            let from = base_dir.join(format!("secure-exec-native-rename-{iter}.a"));
            let to = base_dir.join(format!("secure-exec-native-rename-{iter}.b"));
            std::fs::write(&from, b"hi").expect("write rename fixture");
            std::fs::rename(&from, &to).expect("rename fixture");
            std::fs::remove_file(&to).expect("remove rename fixture");
        }
        Op::FsReaddir => {
            let entry_count = config.entry_count.unwrap_or(32);
            let dir = base_dir.join("secure-exec-native-readdir");
            std::fs::create_dir_all(&dir).expect("create readdir dir");
            for i in 0..entry_count {
                let path = dir.join(format!("{i}.txt"));
                if !path.exists() {
                    std::fs::write(&path, b"hi").expect("write readdir fixture");
                }
            }
            let count = std::fs::read_dir(dir).expect("read dir").count();
            assert!(count >= entry_count);
        }
        Op::FsFsync => {
            let path = base_dir.join("secure-exec-native-fsync.txt");
            let mut file = File::create(path).expect("create fsync fixture");
            file.write_all(b"hello").expect("write fsync fixture");
            file.sync_all().expect("fsync fixture");
        }
        #[cfg(not(target_family = "wasm"))]
        Op::DnsLookup => {
            let addrs: Vec<_> = ("localhost", 80)
                .to_socket_addrs()
                .expect("resolve localhost")
                .collect();
            assert!(!addrs.is_empty());
        }
        #[cfg(not(target_family = "wasm"))]
        Op::DnsConcurrent => {
            let threads: Vec<_> = (0..4)
                .map(|_| {
                    thread::spawn(|| {
                        let addrs: Vec<_> = ("localhost", 80)
                            .to_socket_addrs()
                            .expect("resolve localhost")
                            .collect();
                        assert!(!addrs.is_empty());
                    })
                })
                .collect();
            for handle in threads {
                handle.join().expect("join resolver");
            }
        }
        #[cfg(not(target_family = "wasm"))]
        Op::TcpConnect => {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind tcp listener");
            let addr = listener.local_addr().expect("listener addr");
            let server = thread::spawn(move || {
                let _ = listener.accept().expect("accept tcp connect");
            });
            let _stream = TcpStream::connect(addr).expect("connect tcp listener");
            server.join().expect("join tcp server");
        }
        #[cfg(not(target_family = "wasm"))]
        Op::TcpEcho => {
            let payload = vec![7_u8; config.size_bytes.unwrap_or(5)];
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind tcp listener");
            let addr = listener.local_addr().expect("listener addr");
            let expected_len = payload.len();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept tcp echo");
                let mut buf = vec![0_u8; expected_len];
                stream.read_exact(&mut buf).expect("read tcp echo");
                stream.write_all(&buf).expect("write tcp echo");
            });
            let mut stream = TcpStream::connect(addr).expect("connect tcp echo");
            stream.write_all(&payload).expect("write client echo");
            let mut buf = vec![0_u8; payload.len()];
            stream.read_exact(&mut buf).expect("read client echo");
            assert_eq!(buf, payload);
            server.join().expect("join tcp server");
        }
        #[cfg(not(target_family = "wasm"))]
        Op::TcpConcurrent => {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind tcp listener");
            let addr = listener.local_addr().expect("listener addr");
            let server = thread::spawn(move || {
                for _ in 0..4 {
                    let (mut stream, _) = listener.accept().expect("accept tcp connect");
                    let mut buf = [0_u8; 1];
                    let _ = stream.read(&mut buf);
                }
            });
            let mut clients = Vec::new();
            for _ in 0..4 {
                clients.push(TcpStream::connect(addr).expect("connect tcp listener"));
            }
            for mut client in clients {
                client.write_all(b"x").expect("write connect byte");
            }
            server.join().expect("join tcp server");
        }
        #[cfg(not(target_family = "wasm"))]
        Op::TcpThroughput => {
            let payload = vec![7_u8; config.size_bytes.unwrap_or(64 * 1024)];
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind tcp listener");
            let addr = listener.local_addr().expect("listener addr");
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept tcp throughput");
                let mut buf = vec![0_u8; 64 * 1024];
                stream.read_exact(&mut buf).expect("read tcp throughput");
                stream.write_all(&buf).expect("write tcp throughput");
            });
            let mut stream = TcpStream::connect(addr).expect("connect tcp throughput");
            stream.write_all(&payload).expect("write client throughput");
            let mut out = vec![0_u8; payload.len()];
            stream.read_exact(&mut out).expect("read client throughput");
            assert_eq!(out.len(), payload.len());
            server.join().expect("join tcp server");
        }
        #[cfg(not(target_family = "wasm"))]
        Op::TcpTinyWrites => {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind tcp listener");
            let addr = listener.local_addr().expect("listener addr");
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept tcp tiny");
                let mut buf = [0_u8; 16];
                stream.read_exact(&mut buf).expect("read tcp tiny");
                stream.write_all(&buf).expect("write tcp tiny");
            });
            let mut stream = TcpStream::connect(addr).expect("connect tcp tiny");
            for _ in 0..16 {
                stream.write_all(b"x").expect("write tiny byte");
            }
            let mut out = [0_u8; 16];
            stream.read_exact(&mut out).expect("read tiny echo");
            server.join().expect("join tcp server");
        }
        #[cfg(not(target_family = "wasm"))]
        Op::UdpEcho => {
            let payload = vec![7_u8; config.size_bytes.unwrap_or(5)];
            let server = UdpSocket::bind("127.0.0.1:0").expect("bind udp server");
            let addr = server.local_addr().expect("udp addr");
            let expected_len = payload.len();
            let handle = thread::spawn(move || {
                let mut buf = vec![0_u8; expected_len];
                let (n, peer) = server.recv_from(&mut buf).expect("recv udp");
                server.send_to(&buf[..n], peer).expect("send udp");
            });
            let client = UdpSocket::bind("127.0.0.1:0").expect("bind udp client");
            client.send_to(&payload, addr).expect("send udp client");
            let mut buf = vec![0_u8; payload.len()];
            let (n, _) = client.recv_from(&mut buf).expect("recv udp client");
            assert_eq!(n, payload.len());
            assert_eq!(buf, payload);
            handle.join().expect("join udp server");
        }
        #[cfg(not(target_family = "wasm"))]
        Op::PipeEcho => {
            let out = Command::new("/bin/sh")
                .args(["-c", "printf hello | cat >/dev/null"])
                .output()
                .expect("run pipe echo");
            assert!(out.status.success(), "pipe command failed: {out:?}");
        }
        #[cfg(not(target_family = "wasm"))]
        Op::PipeThroughput | Op::PipeBackpressure => {
            #[cfg(unix)]
            {
                let (mut left, mut right) = UnixStream::pair().expect("unix stream pair");
                let payload = vec![9_u8; config.size_bytes.unwrap_or(64 * 1024)];
                let expected_len = payload.len();
                let reader = thread::spawn(move || {
                    let mut out = vec![0_u8; expected_len];
                    right.read_exact(&mut out).expect("pipe read");
                    out
                });
                left.write_all(&payload).expect("pipe write");
                let out = reader.join().expect("join pipe reader");
                assert_eq!(out.len(), payload.len());
            }
            #[cfg(not(unix))]
            {
                let out = Command::new("/bin/sh")
                    .args(["-c", "printf hello | cat >/dev/null"])
                    .output()
                    .expect("run pipe fallback");
                assert!(out.status.success(), "pipe fallback failed: {out:?}");
            }
        }
        Op::CpuLoop => {
            let mut acc = 0_u64;
            for i in 0..2_000_000_u64 {
                acc = acc.wrapping_add(i ^ (acc.rotate_left(7)));
            }
            std::hint::black_box(acc);
        }
        Op::AllocFree => {
            let mut data = vec![0_u8; 4 * 1024 * 1024];
            for (i, byte) in data.iter_mut().enumerate() {
                *byte = (i % 251) as u8;
            }
            std::hint::black_box(data);
        }
        #[cfg(target_family = "wasm")]
        _ => unreachable!("unsupported wasm op checked before execution"),
    }
}

fn arg_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

#[cfg(not(target_family = "wasm"))]
fn run_node_exit_phases() -> Vec<(&'static str, u128)> {
    let total_start = timer_start();
    let spawn_start = timer_start();
    let mut child = Command::new("node")
        .args(["-e", "process.exit(0)"])
        .spawn()
        .expect("spawn node failed");
    let spawn_ns = elapsed_ns(spawn_start);

    let wait_start = timer_start();
    let status = child.wait().expect("wait node child");
    let wait_ns = elapsed_ns(wait_start);
    assert!(status.success(), "expected exit 0, got {status:?}");

    vec![
        ("total", elapsed_ns(total_start)),
        ("spawn", spawn_ns),
        ("wait_reap", wait_ns),
    ]
}

#[cfg(not(target_family = "wasm"))]
fn run_node_fanout_phases() -> Vec<(&'static str, u128)> {
    let total_start = timer_start();
    let spawn_start = timer_start();
    let mut children = Vec::new();
    for _ in 0..8 {
        children.push(
            Command::new("node")
                .args(["-e", "process.exit(0)"])
                .spawn()
                .expect("spawn node failed"),
        );
    }
    let spawn_ns = elapsed_ns(spawn_start);

    let wait_start = timer_start();
    for mut child in children {
        let status = child.wait().expect("wait node child");
        assert!(status.success(), "expected exit 0, got {status:?}");
    }
    let wait_ns = elapsed_ns(wait_start);

    vec![
        ("total", elapsed_ns(total_start)),
        ("spawn_batch", spawn_ns),
        ("wait_reap_batch", wait_ns),
    ]
}

#[cfg(not(target_family = "wasm"))]
fn run_phases_once(op: Op) -> Option<Vec<(&'static str, u128)>> {
    match op {
        Op::NodeExit => Some(run_node_exit_phases()),
        Op::NodeFanout | Op::NodeReapStorm => Some(run_node_fanout_phases()),
        _ => None,
    }
}

#[cfg(target_family = "wasm")]
fn run_phases_once(_op: Op) -> Option<Vec<(&'static str, u128)>> {
    None
}

fn write_phase_json(op_name: &str, samples: &[(String, Vec<u128>)]) {
    let mut out = String::with_capacity(1024);
    out.push_str("{\"layer\":\"native\",\"op\":\"");
    out.push_str(op_name);
    out.push_str("\",\"unit\":\"ns\",\"phases\":{");
    for (phase_index, (phase, values)) in samples.iter().enumerate() {
        if phase_index > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(phase);
        out.push_str("\":[");
        for (sample_index, value) in values.iter().enumerate() {
            if sample_index > 0 {
                out.push(',');
            }
            out.push_str(&value.to_string());
        }
        out.push(']');
    }
    out.push_str("}}");
    println!("{out}");
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let op = match arg_value(&args, "--op").as_deref() {
        Some("spawn_exit") => Op::SpawnExit,
        Some("exec_capture") => Op::ExecCapture,
        Some("node_stdout_discard_2b") => Op::NodeStdoutDiscard2b,
        Some("node_stdout_capture_2b") => Op::NodeStdoutCapture2b,
        Some("node_stdout_listener_only_2b") => Op::NodeStdoutListenerOnly2b,
        Some("node_exit") => Op::NodeExit,
        Some("node_fanout") => Op::NodeFanout,
        Some("node_reap_storm") => Op::NodeReapStorm,
        Some("pipe_chain") => Op::PipeChain,
        Some("fs_stat") => Op::FsStat,
        Some("fs_write") => Op::FsWrite,
        Some("fs_read") => Op::FsRead,
        Some("fs_open_close") => Op::FsOpenClose,
        Some("fs_mkdir_rmdir") => Op::FsMkdirRmdir,
        Some("fs_rename") => Op::FsRename,
        Some("fs_readdir") => Op::FsReaddir,
        Some("fs_fsync") => Op::FsFsync,
        Some("dns_lookup") => Op::DnsLookup,
        Some("dns_concurrent") => Op::DnsConcurrent,
        Some("tcp_connect") => Op::TcpConnect,
        Some("tcp_echo") => Op::TcpEcho,
        Some("tcp_concurrent") => Op::TcpConcurrent,
        Some("tcp_throughput") => Op::TcpThroughput,
        Some("tcp_tiny_writes") => Op::TcpTinyWrites,
        Some("udp_echo") => Op::UdpEcho,
        Some("pipe_echo") => Op::PipeEcho,
        Some("pipe_throughput") => Op::PipeThroughput,
        Some("pipe_backpressure") => Op::PipeBackpressure,
        Some("cpu_loop") => Op::CpuLoop,
        Some("alloc_free") => Op::AllocFree,
        other => {
            eprintln!("unknown --op {other:?}");
            std::process::exit(2);
        }
    };
    let op_name = match op {
        Op::SpawnExit => "spawn_exit",
        Op::ExecCapture => "exec_capture",
        Op::NodeStdoutDiscard2b => "node_stdout_discard_2b",
        Op::NodeStdoutCapture2b => "node_stdout_capture_2b",
        Op::NodeStdoutListenerOnly2b => "node_stdout_listener_only_2b",
        Op::NodeExit => "node_exit",
        Op::NodeFanout => "node_fanout",
        Op::NodeReapStorm => "node_reap_storm",
        Op::PipeChain => "pipe_chain",
        Op::FsStat => "fs_stat",
        Op::FsWrite => "fs_write",
        Op::FsRead => "fs_read",
        Op::FsOpenClose => "fs_open_close",
        Op::FsMkdirRmdir => "fs_mkdir_rmdir",
        Op::FsRename => "fs_rename",
        Op::FsReaddir => "fs_readdir",
        Op::FsFsync => "fs_fsync",
        Op::DnsLookup => "dns_lookup",
        Op::DnsConcurrent => "dns_concurrent",
        Op::TcpConnect => "tcp_connect",
        Op::TcpEcho => "tcp_echo",
        Op::TcpConcurrent => "tcp_concurrent",
        Op::TcpThroughput => "tcp_throughput",
        Op::TcpTinyWrites => "tcp_tiny_writes",
        Op::UdpEcho => "udp_echo",
        Op::PipeEcho => "pipe_echo",
        Op::PipeThroughput => "pipe_throughput",
        Op::PipeBackpressure => "pipe_backpressure",
        Op::CpuLoop => "cpu_loop",
        Op::AllocFree => "alloc_free",
    };
    #[cfg(target_family = "wasm")]
    if !op.supported_on_wasm() {
        println!("{{\"unsupported\":true,\"op\":\"{op_name}\"}}");
        return;
    }
    let iters: usize = arg_value(&args, "--iters")
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);
    let warmup: usize = arg_value(&args, "--warmup")
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);
    let base_dir = if let Some(path) = arg_value(&args, "--base-dir") {
        let path = std::path::PathBuf::from(path);
        if !path.exists() {
            std::fs::create_dir_all(&path).expect("create base dir");
        }
        path
    } else {
        std::env::temp_dir()
    };
    let config = BenchConfig {
        size_bytes: arg_value(&args, "--size-bytes").and_then(|s| s.parse().ok()),
        entry_count: arg_value(&args, "--entry-count").and_then(|s| s.parse().ok()),
    };
    let phases = args.iter().any(|arg| arg == "--phases");

    let total = warmup + iters;
    if phases {
        let Some(first) = run_phases_once(op) else {
            eprintln!("--phases is not supported for --op {op_name}");
            std::process::exit(2);
        };
        let mut phase_samples = first
            .into_iter()
            .map(|(name, _)| (name.to_string(), Vec::with_capacity(iters)))
            .collect::<Vec<_>>();
        for i in 0..total {
            let phase_values = run_phases_once(op).expect("checked phase support");
            if i >= warmup {
                for (phase_name, value) in phase_values {
                    if let Some((_, values)) = phase_samples
                        .iter_mut()
                        .find(|(name, _)| name == phase_name)
                    {
                        values.push(value);
                    }
                }
            }
        }
        write_phase_json(op_name, &phase_samples);
        return;
    }

    let mut samples: Vec<u128> = Vec::with_capacity(iters);
    for i in 0..total {
        let t = timer_start();
        run_once(op, i, &base_dir, &config);
        let ns = elapsed_ns(t);
        if i >= warmup {
            samples.push(ns);
        }
    }

    // Hand-built JSON (no serde dep): {"layer":"native","op":..,"unit":"ns","samples":[..]}
    let mut out = String::with_capacity(samples.len() * 8 + 64);
    out.push_str("{\"layer\":\"native\",\"op\":\"");
    out.push_str(op_name);
    out.push_str("\",\"unit\":\"ns\",\"samples\":[");
    for (i, s) in samples.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&s.to_string());
    }
    out.push_str("]}");
    println!("{out}");
}
