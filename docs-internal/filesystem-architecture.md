# Pluggable Filesystem Architecture

This document explains the consolidated virtual filesystem shape. The spec is
the build plan; this file is the durable reader-facing reference for engineers
integrating or extending the filesystem.

## Layered Model

The filesystem is a ports-and-adapters stack:

1. Guest/kernel/FUSE callers use a VFS surface.
2. Engines implement filesystem behavior.
3. Engines call metadata and block/object traits.
4. Backends store metadata rows, block bytes, or native objects.

`vfs` owns the generic filesystem layers. Its `posix` module contains the
in-memory POSIX filesystem, overlay, mount table, root filesystem, and
filesystem usage accounting. Its `engine` module contains the generic async
traits, chunked/object engines, cache, and in-memory stores. It has no
secure-exec sidecar, bridge, S3, SQLite, host-disk, or RivetKit dependency.

`secure-exec-vfs` owns the concrete secure-exec backends: S3 block/object
adapters, SQLite metadata, file block storage, and callback metadata over the
sidecar bridge. Sidecar plugins parse trusted mount descriptors, enforce policy
placement, and compose those backends with `vfs` engines.

In secure-exec, `vfs::adapter::MountedEngineFileSystem` adapts the async
`vfs::engine::VirtualFileSystem` trait to the POSIX `MountedFileSystem` trait
consumed by the kernel mount table. The `object_s3` plugin composes `ObjectFs`
with `S3ObjectBackend`. The `chunked_s3` plugin composes `ChunkedFs` with
`CachedMetadataStore<SqliteMetadataStore>` or callback metadata and
`S3BlockStore`. The `chunked_local` plugin composes the same chunked engine with
SQLite metadata and a local file block store for native roots and local durable
mounts. Callback metadata uses the existing sidecar Ext envelope with namespace
`secure-exec.vfs.metadata.v1`, carrying a JSON `MetadataCallbackRequest` and
returning a JSON `MetadataCallbackResponse`. Removal of the legacy
manifest-backed `s3` and `sqlite_vfs` plugins is complete; S3 data now uses
native object keys or chunk blocks plus metadata, not a tree-wide JSON manifest.

## Engines

`ObjectFs` maps paths directly to object keys. Files are native objects, empty
directories use marker objects, and directory listings are synthesized from key
prefixes. This mode is best when outside tools need to read and write the same
bucket layout. It intentionally has lossy POSIX semantics: rename is copy plus
delete, hard links are unsupported, symlinks are marker objects, and partial
writes rewrite the whole object.

`ChunkedFs` is the managed POSIX filesystem. Small files are stored inline in
metadata, while larger files are split into content-addressed chunks. Metadata
is authoritative; blocks are durable byte values addressed by hash.

## Metadata

`MetadataStore` is coarse and async. Path resolution happens inside the backend,
so `resolve("/a/b/c")` is one call instead of one call per path component.
Mutations are fixed filesystem operations: create, link, remove, rename,
attribute patch, and write commit. Each method is one backend transaction and,
for a remote callback store, one wire round trip.

`CachedMetadataStore` decorates any metadata store. The single-writer invariant
makes read caching sound: this VM is the only writer, and every mutation goes
through the decorator, which invalidates cached resolve, lstat, and list results.

The RivetKit actor integration will implement the same coarse API over
`ctx.db_*` SQLite through the secure-exec bridge. The local SQLite schema is the
shared contract for the Rust and TypeScript implementations.

The callback request body is:

- `mountId`: the configured metadata mount id.
- `method`: one of the coarse metadata methods (`resolve`, `resolveParent`,
  `lstat`, `listDir`, `create`, `link`, `remove`, `rename`, `setAttr`,
  `commitWrite`, `getChunks`, `snapshot`, `fork`, `gc`) with the same arguments
  as the Rust trait.

The callback response body is one typed result variant: inode metadata, parent
plus final name, dentry stats, unit, block keys, chunk refs, snapshot id, forked
root inode, or an error with POSIX code and message.

## Content Addressing, Snapshots, and GC

Chunk keys are `blake3(content)`. Identical chunks share one block object, so
deduplication falls out of normal writes. Metadata tracks chunk references and
refcounts. A snapshot copies metadata and increments reachable block refs. A
fork creates a mutable metadata clone that points at the same blocks until a
write produces new chunk hashes.

Garbage collection deletes blocks only after metadata transactions reduce their
refcount to zero. Engines write blocks before committing metadata, so a crash can
leave orphan blocks, but cannot leave metadata pointing at unwritten chunks.
Snapshot lifecycle is not complete yet: the trait can create and fork snapshots,
but it has no snapshot deletion method, and durable stores do not persist full
snapshot contents. Do not use snapshots for production mounts that require block
reclamation until that lifecycle exists.

## Durability and Consistency

The model is single-writer. Metadata commits are atomic per filesystem
operation. For `ChunkedFs`, write ordering is block store first, then
`commit_write`. A future secure-exec adapter must make `fsync` and close wait
for both dirty block writes and the metadata commit acknowledgement.

The old S3 JSON manifest design reserialized a full tree and uploaded it
non-atomically. This architecture removes that format. Metadata rows are the
source of truth, and block cleanup is explicit.

## Storage Format

Inline file data is stored as raw bytes in metadata. Chunked file data is stored
as a chunk map from `(ino, chunk_index)` to a content-addressed block key. The
default inline threshold is 64 KiB. The default chunk size is 4 MiB.

The canonical metadata tables are:

- `inodes`: inode type, mode, owner, size, timestamps, storage mode, inline
  content, and symlink target.
- `dentries`: `(parent_ino, name) -> child_ino`.
- `chunks`: `(ino, chunk_index) -> block_key, len`.
- `block_refs`: block key refcounts.
- `snapshots`: snapshot id, root inode, and creation time.

Object storage layout differs by engine. `ObjectFs` uses one object per file
under its configured prefix. `S3ObjectBackend` lists one prefix level at a time
using S3 delimiters; recursive operations in `ObjectFs` walk those prefixes.
`ChunkedFs` stores blocks by content hash through a `BlockStore`. `S3BlockStore`
maps each `BlockKey` to an object under its configured prefix, so chunk layout is
content-addressed and independent from inode numbers.

## Prior Art

JuiceFS is the closest reference for the split between metadata engines and
object-backed chunks, plus clone and GC behavior. S3QL is the closest reference
for SQLite metadata with deduplicated content-addressed blocks and snapshots.
Mountpoint-S3 demonstrates the transparent object mapping trade-off: native
object interoperability is valuable, but POSIX must be intentionally narrowed.
ZeroFS and SlateDB inform the durability line between metadata and object
storage, especially strong fsync barriers. ObjectiveFS is useful prior art for
small-file packing and snapshot scheduling, which remain future extensions.
