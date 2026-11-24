// File bytes per SQLite row, under the 2 MB row cap.
export const VFS_CHUNK = 1 << 20;

// The last row grows in place while under this: rows written are billed, so an AOF append is one row.
export const VFS_TAIL = 16 << 10;

// Deleted files' chunks go a little at a time, so no commit frees (and makes SQLite move) a whole file.
export const VFS_SWEEP_BYTES = 2 << 20;
export const VFS_SWEEP_MS = 50;

// Chunk rows one sweep step reads, so a file of many small rows still costs a bounded read per step.
export const VFS_SWEEP_ROWS = 4096;
