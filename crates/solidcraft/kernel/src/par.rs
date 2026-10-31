//! Ordered parallel map over independent items, on the process-wide worker pool (with the
//! `threads` feature; without it everything runs serially). Each item runs under [`crate::guard`],
//! so a panic in one item is that item's error and never reaches the pool.
//!
//! PushForm: the feature replaces the gates on the target (the WebAssembly build with threads runs
//! the same code), and [`set_threads`] tells the kernel how many threads the host offers, since
//! `available_parallelism` knows nothing there.

use std::sync::atomic::{AtomicUsize, Ordering};

use crate::{Result, guard};

/// The thread count the host set; 0 until it does.
static THREADS: AtomicUsize = AtomicUsize::new(0);

/// PushForm: how many threads the kernel may use. Set it once, before any kernel work, where the
/// host knows better than `available_parallelism` (the browser); with the `threads` feature it
/// also sizes the worker pool, once.
pub fn set_threads(n: usize) {
    let n = n.max(1);
    THREADS.store(n, Ordering::Relaxed);
    // The worker pool is sized natively only. In the browser its threads leave the main instance waiting forever
    // once it hands them work (not so under Node; the cause is not yet understood), so there the pool stays at the
    // one thread rayon makes by itself and `map` runs serially, while the plain threads of `map_on_threads` (the
    // STEP conversion workers) and the caller's own threads still run.
    #[cfg(all(feature = "threads", not(target_arch = "wasm32")))]
    {
        // Meshing recurses: give the pool's threads room.
        let _ = rayon::ThreadPoolBuilder::new().num_threads(n).stack_size(4 << 20).build_global();
    }
}

/// Threads the kernel may use: what the host set, else the cores.
pub fn threads() -> usize {
    match THREADS.load(Ordering::Relaxed) {
        0 => std::thread::available_parallelism().map_or(1, |n| n.get()),
        n => n,
    }
}

/// `f` over `items`, results in item order: on the pool when `parallel`, else on the calling
/// thread. Waking the pool's workers costs tens of microseconds, so callers ask for it only
/// when the items carry more work than that (decided from the work, not the item count).
pub(crate) fn map<T: Sync, R: Send>(what: &'static str, items: &[T], parallel: bool, f: impl Fn(&T) -> Result<R> + Sync) -> Vec<Result<R>> {
    let one = |item: &T| guard(what, || f(item));
    // Without threads there is no worker pool: everything runs on the calling thread.
    #[cfg(not(feature = "threads"))]
    let _ = parallel;
    #[cfg(feature = "threads")]
    {
        use rayon::prelude::*;
        if parallel && items.len() > 1 && rayon::current_num_threads() > 1 {
            return items.par_iter().map(one).collect();
        }
    }
    items.iter().map(one).collect()
}

/// Run `f` on every item, spread over plain threads (one per core, at most `max_threads`),
/// each pulling the next item; on the calling thread in the browser build or when threads
/// cannot be started. Each call runs under [`crate::guard`] (a panic is that item's loss).
///
/// Plain threads rather than the worker pool: an item may wait on a lazily filled cell that
/// another item is filling, and a pool worker that picked up a second item while it waited
/// inside its own item's parallel work could wait on itself.
pub fn for_each_on_threads<T: Sync>(items: &[T], max_threads: usize, f: impl Fn(&T) + Sync) {
    let _ = map_on_threads(items, max_threads, f);
}

/// Independent kernel jobs, with one computation lane per native dispatcher. Each dispatcher
/// owns a single-thread Rayon pool: nested triangulation neither queues behind a common
/// one-thread pool nor multiplies the requested concurrency. No second body can be stolen by
/// a worker while it fills a shared lazy mesh cell. The browser runs serially.
pub fn map_with_local_pools<T: Sync, R: Send>(items: &[T], max_threads: usize, f: impl Fn(&T) -> Result<R> + Sync) -> Vec<Result<R>> {
    #[cfg(feature = "threads")]
    let one = |item: &T| {
        use std::cell::OnceCell;
        thread_local! {
            static POOL: OnceCell<rayon::ThreadPool> = const { OnceCell::new() };
        }
        POOL.with(|cell| {
            if cell.get().is_none() {
                let pool = rayon::ThreadPoolBuilder::new()
                    .num_threads(1)
                    .stack_size(4 << 20)
                    .build()
                    .map_err(|e| crate::KernelError::Failed(format!("cannot start mesh worker: {e}")))?;
                let _ = cell.set(pool);
            }
            let pool = cell.get().ok_or_else(|| crate::KernelError::Failed("missing mesh worker".into()))?;
            pool.install(|| guard("mesh worker", || f(item)))
        })
    };
    #[cfg(not(feature = "threads"))]
    let one = |item: &T| guard("mesh worker", || f(item));
    map_on_threads(items, max_threads, one)
        .into_iter()
        .map(|r| r.unwrap_or_else(|| Err(crate::KernelError::Internal("mesh worker failed".into()))))
        .collect()
}

/// PushForm: `f` over `items` on threads (one per core, at most `max_threads`), each result handed to
/// `on_done` on the calling thread as soon as it is in, in completion order, with its item's index;
/// `None` where an item panicked. Without threads, one item at a time on the calling thread.
pub fn for_each_completed<T: Sync, R: Send>(items: &[T], max_threads: usize, f: impl Fn(&T) -> R + Sync, mut on_done: impl FnMut(usize, Option<R>)) {
    let one = |item: &T| guard("parallel item", || Ok(f(item))).ok();
    #[cfg(feature = "threads")]
    {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let threads = self::threads().min(max_threads).min(items.len());
        if threads > 1 {
            let next = AtomicUsize::new(0);
            let (tx, rx) = std::sync::mpsc::channel::<(usize, Option<R>)>();
            let work = |tx: std::sync::mpsc::Sender<(usize, Option<R>)>| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(i) else { break };
                    if tx.send((i, one(item))).is_err() { break; }
                }
            };
            std::thread::scope(|scope| {
                let started: Vec<_> = (0..threads)
                    .filter_map(|_| {
                        let tx = tx.clone();
                        std::thread::Builder::new().name("solidcraft-each".into()).stack_size(4 << 20).spawn_scoped(scope, move || work(tx)).ok()
                    })
                    .collect();
                drop(tx);
                if started.is_empty() {
                    // No thread could start: every item here, one at a time.
                    for (i, item) in items.iter().enumerate() { on_done(i, one(item)); }
                    return;
                }
                for (i, r) in rx { on_done(i, r); }
            });
            return;
        }
    }
    let _ = max_threads;
    for (i, item) in items.iter().enumerate() { on_done(i, one(item)); }
}

/// `f` over `items` as [`for_each_on_threads`] runs it, results in item order (`None` where an
/// item panicked).
pub fn map_on_threads<T: Sync, R: Send>(items: &[T], max_threads: usize, f: impl Fn(&T) -> R + Sync) -> Vec<Option<R>> {
    let one = |item: &T| guard("parallel item", || Ok(f(item))).ok();
    #[cfg(feature = "threads")]
    {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let threads = std::thread::available_parallelism().map(usize::from).unwrap_or(1).min(max_threads).min(items.len());
        if threads > 1 {
            let next = AtomicUsize::new(0);
            let work = || {
                let mut done = Vec::new();
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(i) else { break };
                    done.push((i, one(item)));
                }
                done
            };
            let mut out: Vec<Option<R>> = std::iter::repeat_with(|| None).take(items.len()).collect();
            std::thread::scope(|scope| {
                // A thread that cannot start leaves its share to the others.
                let helpers: Vec<_> =
                    (1..threads).filter_map(|_| std::thread::Builder::new().name("solidcraft-each".into()).stack_size(4 << 20).spawn_scoped(scope, work).ok()).collect();
                let mut all = work();
                for h in helpers {
                    // `work` never panics (every item runs under the guard).
                    if let Ok(done) = h.join() {
                        all.extend(done);
                    }
                }
                for (i, r) in all {
                    if let Some(slot) = out.get_mut(i) {
                        *slot = r;
                    }
                }
            });
            return out;
        }
    }
    let _ = max_threads;
    items.iter().map(one).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::KernelError;

    #[test]
    fn local_pools_keep_order_and_errors_and_bound_nested_parallelism() {
        let items: Vec<usize> = (0..32).collect();
        let result = map_with_local_pools(&items, 8, |i| {
            #[cfg(feature = "threads")]
            assert_eq!(rayon::current_num_threads(), 1);
            if *i == 7 { Err(KernelError::Invalid("seven".into())) } else { Ok(*i * 2) }
        });
        for (i, r) in result.iter().enumerate() {
            assert_eq!(r.as_ref().ok().copied(), (i != 7).then_some(i * 2));
        }
    }

    #[test]
    fn each_item_once_on_threads() {
        let items: Vec<u32> = (0..1000).collect();
        let seen: Vec<std::sync::atomic::AtomicU32> = (0..1000).map(|_| std::sync::atomic::AtomicU32::new(0)).collect();
        for_each_on_threads(&items, 8, |x| {
            seen[*x as usize].fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            assert!(*x != 500, "a panicking item is that item's loss");
        });
        assert!(seen.iter().all(|s| s.load(std::sync::atomic::Ordering::Relaxed) == 1));
    }

    #[test]
    fn map_on_threads_keeps_order() {
        let items: Vec<u32> = (0..1000).collect();
        let out = map_on_threads(&items, 8, |x| {
            assert!(*x != 7, "a panicking item is that item's loss");
            x * 3
        });
        assert_eq!(out.len(), 1000);
        for (i, r) in out.iter().enumerate() {
            assert_eq!(*r, (i != 7).then_some(3 * i as u32));
        }
    }

    #[test]
    fn keeps_order_and_errors() {
        let items: Vec<u32> = (0..1000).collect();
        let out = map("test", &items, true, |x| if *x == 500 { Err(KernelError::Invalid("five hundred".into())) } else { Ok(x * 2) });
        assert_eq!(out.len(), 1000);
        for (i, r) in out.iter().enumerate() {
            match r {
                Ok(v) => assert_eq!(*v, 2 * i as u32),
                Err(_) => assert_eq!(i, 500),
            }
        }
    }
}
